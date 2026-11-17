#!/usr/bin/env python3
"""Auto Seek backend: finds where the action starts in each scene, on the server.

Stash runs this once per plugin operation, task and hook with the raw
interface: a JSON request on stdin ({"args": {"op": ...}}) and a JSON reply on
stdout ({"output": ...} or {"error": ...}). Only the standard library is used,
so the plugin needs nothing beyond the Python that Stash already runs plugins
with.

Scoring: Stash's own ffmpeg cuts frames as raw RGB, and a tuned CLIP image
model (int8 ONNX, CLIP's preprocessing inside the graph) scores each one
through ONNX Runtime's C API (``ort_api.py``). The search samples the scene at
the preview's segment times, scans the stretch where the score changes, and
bisects to the first frame past the threshold (see ``search``). Results are
kept per scene in ``data/cache.sqlite3``; the player reads them.

Files: the model and the ONNX Runtime build for this platform are downloaded
on first use into ``data/files``. The download runs in a detached child
process (``auto_seek.py <dir> download``) so the operation that starts it
returns at once. A lock file, refreshed while bytes arrive, keeps a second
download from starting; a lock that stops being refreshed counts as
abandoned. Partial files resume with HTTP Range requests, and every file is
checked against its pinned SHA-256 before it is used.

Background work: the "Find start points" task works through the library, and
a hook on new scenes queues them for a detached worker
(``auto_seek.py <dir> worker``), which runs one at a time at low priority.
"""

import base64
import contextlib
import glob
import hashlib
import json
import math
import os
import platform
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ort_api

PLUGIN_ID = "auto-seek"
PLUGIN_DIR = os.path.realpath(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(__file__))
DATA_DIR = os.path.join(PLUGIN_DIR, "data")
FILES_DIR = os.path.join(DATA_DIR, "files")
STATE_PATH = os.path.join(DATA_DIR, "download.json")
LOCK_PATH = os.path.join(DATA_DIR, "download.lock")
VERIFIED_PATH = os.path.join(DATA_DIR, "verified.json")
CACHE_PATH = os.path.join(DATA_DIR, "cache.sqlite3")
WORKER_LOCK_PATH = os.path.join(DATA_DIR, "worker.lock")

# The models: CLIP (LAION-2B) with its last three blocks tuned to tell which
# acts a frame shows, int8 weights, raw RGB bytes in. Two sizes: ViT-B/32 is
# quicker, ViT-B/16 looks at four times the patches and finds starts a little
# more accurately. Pinned to a commit of https://huggingface.co/mrx-31415/auto-seek.
HF = "https://huggingface.co/mrx-31415/auto-seek/resolve/8fdb176bd763c498f6a695d7b9efd22067dbb83e/"
MODELS = {
    "fast": {
        "path": "models/auto-seek-acts-b32-v1.onnx",
        "url": HF + "auto-seek-acts-b32-v1.onnx",
        "sha256": "685eb33581b8f2003c8ba0b3022b93da09ab5a0599e8d81bc2a8bbe566e528cb",
        "size": 88670767,
        "id": "acts-b32-v1",
    },
    "accurate": {
        "path": "models/auto-seek-acts-b16-v1.onnx",
        "url": HF + "auto-seek-acts-b16-v1.onnx",
        "sha256": "a41a4f7c1ad0e9e5ed1b231fd5b77882efdcfc266202ddaf6ce41f0bf9cf35a0",
        "size": 87353144,
        "id": "acts-b16-v1",
    },
}
ACTS = (
    "nothing yet", "kissing", "striptease / tease", "massage / oil", "breast worship",
    "ass worship", "masturbation / toys", "oral on him", "oral on her", "69", "rimming",
    "handjob", "fingering", "titjob", "cowgirl", "missionary", "doggy style", "prone bone",
    "side/spoon", "ballerina", "stand & carry", "pile driving", "scissoring", "facial",
    "in mouth", "on body", "creampie", "foot play",
)  # fmt: skip
FOREPLAY = ("kissing", "striptease / tease", "massage / oil", "breast worship", "ass worship",
            "masturbation / toys")  # fmt: skip
POSITIONS = ("cowgirl", "missionary", "doggy style", "prone bone", "side/spoon", "ballerina",
             "stand & carry", "pile driving", "scissoring")  # fmt: skip
LATER = ("oral on him", "oral on her", "69", "rimming", "handjob", "fingering", "titjob",
         *POSITIONS, "facial", "in mouth", "on body", "creampie")  # fmt: skip
# Where the action counts as started: a frame's score is the chance that it
# shows any of the stage's acts. The first two are experimental (foreplay is
# the least reliable to tell apart from an intro).
STAGES = {
    "anything": FOREPLAY + LATER,
    "foreplay": tuple(act for act in FOREPLAY if act != "striptease / tease") + LATER,
    "kissing": ("kissing", *LATER),
    "oral": LATER,
    "sex": POSITIONS,
}
DEFAULT_STAGE = "oral"
CHOICE_PATH = os.path.join(DATA_DIR, "choice.json")


def stage_of(settings: dict) -> str:
    """The start-stage setting: a free-text field, read leniently ("Kissing
    or later", "sex positions", ...), or the settings page's own pick of acts
    ("acts: kissing, cowgirl"), kept as "acts:" and their indexes in ACTS. A
    pick that matches a stage is that stage, so its starts stay cached."""
    text = str(settings.get("startStage") or "").strip().lower()
    if text.startswith("acts:"):
        names = {name.strip() for name in text[5:].split(",")}
        picked = tuple(act for act in ACTS[1:] if act in names)
        if not picked:
            return DEFAULT_STAGE
        same = next((key for key, acts in STAGES.items() if set(acts) == set(picked)), None)
        return same or "acts:" + "-".join(str(ACTS.index(act)) for act in picked)
    for key in ("anything", "foreplay", "kissing", "oral", "sex", "position"):
        if text.startswith(key) or key in text.split():
            return "sex" if key == "position" else key
    return DEFAULT_STAGE


def size_of(settings: dict) -> str:
    return "accurate" if settings.get("accurateModel") is True else "fast"


def model_id(size: str, stage: str) -> str:
    """Part of every cached result: another model, stage or rule recomputes
    older results."""
    return f"{MODELS[size]['id']}/{stage}+t80p10"


def chosen_size() -> str:
    """The model size the settings asked for when last read; downloads and
    the status follow it."""
    size = read_json(CHOICE_PATH, {}).get("size")
    return size if size in MODELS else "fast"


def choose(size: str) -> None:
    """Remember the model size and switch the files to fetch to it."""
    global MODEL, FILES
    if chosen_size() != size or not os.path.isfile(CHOICE_PATH):
        with contextlib.suppress(OSError):
            write_json(CHOICE_PATH, {"size": size})
    MODEL = MODELS[size]
    FILES = files_needed()


# ONNX Runtime per platform: Microsoft's release builds, and for musl (Stash's
# Docker image is Alpine) Alpine's own build with the libraries it needs. Only
# the files named in "members" are kept, under "path".
ORT = "https://github.com/microsoft/onnxruntime/releases/download/v1.31.1/"
MUSL = "https://github.com/mrx-31415/stash-curator/releases/download/auto-seek-runtime-v1/"
RUNTIMES = {
    "linux-x64-glibc": {
        "path": "runtime/ort-1.31.1-linux-x64",
        "url": ORT + "onnxruntime-linux-x64-1.31.1.tgz",
        "sha256": "c849e36a1ef3e22d4ff217b9d1ce4a3cf5b9467b975610913ae959ad5b16bdc9",
        "size": 11413655,
        "members": {
            "onnxruntime-linux-x64-1.31.1/lib/libonnxruntime.so.1.31.1": "libonnxruntime.so",
            "onnxruntime-linux-x64-1.31.1/LICENSE": "LICENSE",
            "onnxruntime-linux-x64-1.31.1/ThirdPartyNotices.txt": "ThirdPartyNotices.txt",
        },
        "library": "libonnxruntime.so",
    },
    "linux-arm64-glibc": {
        "path": "runtime/ort-1.31.1-linux-arm64",
        "url": ORT + "onnxruntime-linux-aarch64-1.31.1.tgz",
        "sha256": "5317505e2da99be65f8e2775ba3c2afd6d2961fd78aba1bd8f56159f48820c78",
        "size": 10332381,
        "members": {
            "onnxruntime-linux-aarch64-1.31.1/lib/libonnxruntime.so.1.31.1": "libonnxruntime.so",
            "onnxruntime-linux-aarch64-1.31.1/LICENSE": "LICENSE",
            "onnxruntime-linux-aarch64-1.31.1/ThirdPartyNotices.txt": "ThirdPartyNotices.txt",
        },
        "library": "libonnxruntime.so",
    },
    "macos-arm64": {
        "path": "runtime/ort-1.31.1-macos-arm64",
        "url": ORT + "onnxruntime-osx-arm64-1.31.1.tgz",
        "sha256": "2e1344a1926ee50eb25b38153cb6992c3567515aef0e677a1a520a1798896d6f",
        "size": 36936435,
        "members": {
            "onnxruntime-osx-arm64-1.31.1/lib/libonnxruntime.1.31.1.dylib": "libonnxruntime.dylib",
            "onnxruntime-osx-arm64-1.31.1/LICENSE": "LICENSE",
            "onnxruntime-osx-arm64-1.31.1/ThirdPartyNotices.txt": "ThirdPartyNotices.txt",
        },
        "library": "libonnxruntime.dylib",
    },
    "windows-x64": {
        "path": "runtime/ort-1.31.1-windows-x64",
        "url": ORT + "onnxruntime-win-x64-1.31.1.zip",
        "sha256": "5869e26bb25314375f2d5ef1877e3ea06b1543d6c710e6e4a1ec2f7177ab4b2c",
        "size": 82929944,
        "members": {
            "onnxruntime-win-x64-1.31.1/lib/onnxruntime.dll": "onnxruntime.dll",
            "onnxruntime-win-x64-1.31.1/LICENSE": "LICENSE",
            "onnxruntime-win-x64-1.31.1/ThirdPartyNotices.txt": "ThirdPartyNotices.txt",
        },
        "library": "onnxruntime.dll",
    },
    "windows-arm64": {
        "path": "runtime/ort-1.31.1-windows-arm64",
        "url": ORT + "onnxruntime-win-arm64-1.31.1.zip",
        "sha256": "817f4129073f84f81cde3ff92b1a4e06d007691e7208deed08a8b6d6df143f7f",
        "size": 85851069,
        "members": {
            "onnxruntime-win-arm64-1.31.1/lib/onnxruntime.dll": "onnxruntime.dll",
            "onnxruntime-win-arm64-1.31.1/LICENSE": "LICENSE",
            "onnxruntime-win-arm64-1.31.1/ThirdPartyNotices.txt": "ThirdPartyNotices.txt",
        },
        "library": "onnxruntime.dll",
    },
    # Built by scripts/build_auto_seek_runtime.sh (Alpine 3.23, ONNX Runtime 1.23).
    "linux-x64-musl": {
        "path": "runtime/ort-alpine-3.23-x64",
        "url": MUSL + "onnxruntime-alpine-3.23-x86_64.tar.gz",
        "sha256": "0534728cbec0ee55f04a57487b362c70f132951d9cc3d93b1ab4cb46ff5a3dd5",
        "size": 8956690,
        "members": "*",
        "library": "libonnxruntime.so",
    },
    "linux-arm64-musl": {
        "path": "runtime/ort-alpine-3.23-arm64",
        "url": MUSL + "onnxruntime-alpine-3.23-aarch64.tar.gz",
        "sha256": "1d1f351097f96aae6b3e8e0e8ed04500830cda45529addcbb5b5eb5b2227287c",
        "size": 7904545,
        "members": "*",
        "library": "libonnxruntime.so",
    },
    "linux-armv7-musl": {
        "path": "runtime/ort-alpine-3.23-armv7",
        "url": MUSL + "onnxruntime-alpine-3.23-armv7.tar.gz",
        "sha256": "99fdc41382c08f5afeb9f067d2e236fe435103366bc8b9d23233f4793ee8f297",
        "size": 7822880,
        "members": "*",
        "library": "libonnxruntime.so",
    },
}


def platform_key() -> str | None:
    """Which ONNX Runtime build runs here, or None if there is none."""
    arch = {
        "x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64",
        "armv7l": "armv7", "armv7": "armv7",
    }.get(platform.machine().lower())  # fmt: skip
    if sys.platform.startswith("linux"):
        musl = bool(glob.glob("/lib/ld-musl-*")) or platform.libc_ver()[0] != "glibc"
        key = f"linux-{arch}-{'musl' if musl else 'glibc'}"
    elif sys.platform == "win32":
        key = f"windows-{arch}"
    elif sys.platform == "darwin":
        key = f"macos-{arch}"
    else:
        return None
    return key if arch and key in RUNTIMES else None


def files_needed() -> tuple[dict, ...]:
    key = platform_key()
    return (MODEL, RUNTIMES[key]) if key in RUNTIMES else (MODEL,)


LOCK_STALE_SECONDS = 120
CHUNK = 1 << 20


def now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as source:
            return json.load(source)
    except (OSError, ValueError):
        return default


def write_json(path: str, value) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = f"{path}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as out:
        json.dump(value, out)
    os.replace(temporary, path)


MODEL = MODELS[chosen_size()]
FILES = files_needed()


# ── download ──────────────────────────────────────────────────────────────


def target_of(entry: dict) -> str:
    """The file a download provides: the model itself, or the library
    unpacked from a runtime archive."""
    if "members" in entry:
        return os.path.join(FILES_DIR, entry["path"], entry["library"])
    return os.path.join(FILES_DIR, entry["path"])


def file_ready(entry: dict, verified: dict) -> bool:
    """A file counts as ready when it is in place (with the pinned size, for a
    plain file) and was hashed once after download (hashing 89 MB on every
    status call would cost more than the call itself)."""
    target = target_of(entry)
    return (
        verified.get(entry["path"]) == entry["sha256"]
        and os.path.isfile(target)
        and ("members" in entry or os.path.getsize(target) == entry["size"])
    )


def lock_alive() -> bool:
    try:
        return time.time() - os.path.getmtime(LOCK_PATH) < LOCK_STALE_SECONDS
    except OSError:
        return False


def status() -> dict:
    verified = read_json(VERIFIED_PATH, {})
    missing = [entry for entry in FILES if not file_ready(entry, verified)]
    state = read_json(STATE_PATH, {})
    downloading = bool(missing) and lock_alive()
    total = sum(entry["size"] for entry in FILES)
    done = total - sum(entry["size"] for entry in missing)
    if downloading:
        done += int(state.get("received", 0))
    return {
        "supported": platform_key() in RUNTIMES,
        "platform": platform_key() or f"{sys.platform}-{platform.machine()}",
        "ready": not missing and platform_key() in RUNTIMES,
        "downloading": downloading,
        "received": min(done, total),
        "total": total,
        "error": None if downloading or not missing else state.get("error"),
        "files": {entry["path"]: entry["sha256"][:12] for entry in FILES},
    }


def ensure() -> dict:
    """Start the background download unless everything is present or a
    download is already running. Returns at once."""
    current = status()
    if current["ready"] or current["downloading"] or not current["supported"]:
        return current
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(LOCK_PATH, "w", encoding="utf-8") as lock:
        lock.write(str(os.getpid()))
    write_json(STATE_PATH, {"state": "starting", "received": 0, "updated_at": now()})
    arguments = [sys.executable, os.path.abspath(__file__), PLUGIN_DIR, "download"]
    options: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if sys.platform == "win32":
        options["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    subprocess.Popen(arguments, **options)
    return {**status(), "downloading": True}


def fetch(entry: dict, progress) -> None:
    """Download one file, resuming a partial copy, verify its hash, and put it
    in place (unpacking the wanted members of an archive)."""
    archive = "members" in entry
    target = os.path.join(FILES_DIR, entry["path"])
    if archive:
        partial = os.path.join(FILES_DIR, "downloads", os.path.basename(entry["url"]) + ".part")
    else:
        partial = target + ".part"
    os.makedirs(os.path.dirname(partial), exist_ok=True)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    offset = os.path.getsize(partial) if os.path.isfile(partial) else 0
    if offset > entry["size"]:
        os.remove(partial)
        offset = 0
    if offset < entry["size"]:
        request = urllib.request.Request(entry["url"], headers={"User-Agent": "stash-auto-seek"})
        if offset:
            request.add_header("Range", f"bytes={offset}-")
        with urllib.request.urlopen(request, timeout=60) as response:
            if offset and response.status != 206:
                offset = 0  # the server ignored the range; start over
            with open(partial, "ab" if offset else "wb") as out:
                received = offset
                while chunk := response.read(CHUNK):
                    out.write(chunk)
                    received += len(chunk)
                    progress(received)
    digest = hashlib.sha256()
    with open(partial, "rb") as source:
        while block := source.read(CHUNK):
            digest.update(block)
    if digest.hexdigest() != entry["sha256"]:
        os.remove(partial)
        raise ValueError(f"{entry['path']} failed its checksum; it will be fetched again")
    if archive:
        unpack(entry, partial)
        os.remove(partial)
    else:
        os.replace(partial, target)


def unpack(entry: dict, archive: str) -> None:
    """Copy the archive members the entry names (all regular files, flattened,
    for "*") into its folder, replacing an older copy as a whole."""
    target = os.path.join(FILES_DIR, entry["path"])
    staging = target + ".tmp"
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    wanted = entry["members"]

    def keep(name: str) -> str | None:
        if wanted == "*":
            base = os.path.basename(name)
            return base if base and not base.startswith(".") else None
        return wanted.get(name)

    def write(name: str, source) -> None:
        with open(os.path.join(staging, name), "wb") as out:
            shutil.copyfileobj(source, out, CHUNK)

    if archive.endswith(".zip.part") or zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as bundle:
            for info in bundle.infolist():
                name = keep(info.filename)
                if name and not info.is_dir():
                    with bundle.open(info) as source:
                        write(name, source)
    else:
        with tarfile.open(archive, "r:*") as bundle:
            for member in bundle.getmembers():
                name = keep(member.name)
                if name and member.isfile():
                    write(name, bundle.extractfile(member))
    missing = [
        name
        for name in ([entry["library"]] if wanted == "*" else wanted.values())
        if not os.path.isfile(os.path.join(staging, name))
    ]
    if missing:
        shutil.rmtree(staging, ignore_errors=True)
        raise ValueError(f"{os.path.basename(entry['url'])} lacks {', '.join(missing)}")
    shutil.rmtree(target, ignore_errors=True)
    os.replace(staging, target)


def remove_unused(verified: dict) -> None:
    """Delete downloads an earlier version pinned (an older model, or the
    other model size), so a switch doesn't leave 90 MB behind."""
    wanted = {entry["path"] for entry in FILES}
    root = os.path.realpath(FILES_DIR)
    for path in [path for path in verified if path not in wanted]:
        target = os.path.realpath(os.path.join(FILES_DIR, path))
        if target.startswith(root + os.sep):
            if os.path.isdir(target):
                shutil.rmtree(target, ignore_errors=True)
            else:
                with contextlib.suppress(OSError):
                    os.remove(target)
        del verified[path]
    write_json(VERIFIED_PATH, verified)


def download() -> None:
    verified = read_json(VERIFIED_PATH, {})
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(LOCK_PATH, "a", encoding="utf-8"):
        pass  # refreshed while bytes arrive; ensure() normally made it already
    try:
        for entry in FILES:
            if file_ready(entry, verified):
                continue
            last = 0.0

            def progress(received: int, path: str = entry["path"]) -> None:
                nonlocal last
                if time.time() - last >= 1:
                    last = time.time()
                    write_json(
                        STATE_PATH,
                        {
                            "state": "downloading",
                            "file": path,
                            "received": received,
                            "updated_at": now(),
                        },
                    )
                    os.utime(LOCK_PATH)

            progress(0)
            fetch(entry, progress)
            verified[entry["path"]] = entry["sha256"]
            write_json(VERIFIED_PATH, verified)
        remove_unused(verified)
        write_json(STATE_PATH, {"state": "ready", "received": 0, "updated_at": now()})
    except Exception as error:  # reported to the UI through status()
        write_json(
            STATE_PATH,
            {"state": "error", "error": str(error), "received": 0, "updated_at": now()},
        )
    finally:
        with contextlib.suppress(OSError):
            os.remove(LOCK_PATH)


# ── start-point cache ─────────────────────────────────────────────────────


def cache() -> sqlite3.Connection:
    os.makedirs(DATA_DIR, exist_ok=True)
    connection = sqlite3.connect(CACHE_PATH, timeout=10)
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if version < 1:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS start_point (
                scene_id TEXT PRIMARY KEY,
                start_s REAL NOT NULL,
                duration_s REAL NOT NULL,
                model TEXT NOT NULL,
                scores TEXT NOT NULL DEFAULT '[]',
                computed_at TEXT NOT NULL
            );
            PRAGMA user_version = 1;
            """
        )
    if version < 2:
        # Starts the viewer marked by hand. Kept apart from the computed ones,
        # which a new model replaces, and preferred over them; together with
        # the computed start at the time they are labels for a better model.
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS user_start (
                scene_id TEXT PRIMARY KEY,
                start_s REAL NOT NULL,
                duration_s REAL NOT NULL,
                computed_start_s REAL,
                computed_model TEXT,
                marked_at TEXT NOT NULL
            );
            PRAGMA user_version = 2;
            """
        )
    if version < 3:
        # Scenes the analysis failed on, so the library task doesn't retry them
        # with the same model on every run; and new scenes waiting for the
        # background worker.
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS failure (
                scene_id TEXT PRIMARY KEY,
                model TEXT NOT NULL,
                error TEXT NOT NULL,
                failed_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pending (
                scene_id TEXT PRIMARY KEY,
                added_at TEXT NOT NULL
            );
            PRAGMA user_version = 3;
            """
        )
    if version < 4:
        # The act timeline: every act's score on frames across the whole
        # scene and where each act first shows (state: 0 scanning, 1 done,
        # 2 failed, 3 waiting: frames from the start search, or a scan
        # paused for another scene); and pending scenes a page is waiting
        # for go first (priority: when the page asked).
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS timeline (
                scene_id TEXT PRIMARY KEY,
                model TEXT NOT NULL,
                duration_s REAL NOT NULL,
                frames TEXT NOT NULL DEFAULT '[]',
                firsts TEXT NOT NULL DEFAULT '{}',
                state INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                updated_at TEXT NOT NULL
            );
            ALTER TABLE pending ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
            PRAGMA user_version = 4;
            """
        )
    return connection


ADOPTED_PATH = os.path.join(DATA_DIR, "adopted.json")


def earlier_caches() -> list[str]:
    """Caches left by Auto Seek installed from another plugin source.

    Stash installs a package into <plugins>/<source folder>/<id>, and
    uninstalling deletes only the files the package shipped, so an earlier
    install's data/ stays behind next to this one."""
    own = os.path.realpath(CACHE_PATH)
    parent = os.path.dirname(PLUGIN_DIR)
    found = set()
    for root in {parent, os.path.dirname(parent)}:
        for pattern in ("auto-seek", os.path.join("*", "auto-seek")):
            for path in glob.glob(os.path.join(root, pattern, "data", "cache.sqlite3")):
                if os.path.realpath(path) != own:
                    found.add(os.path.realpath(path))
    return sorted(found, key=os.path.getmtime)


def adopt_earlier_install() -> None:
    """Once per install: bring over the start points and marks of an earlier
    install from another source, so switching sources keeps them. What this
    install already has wins, except a newer mark."""
    if os.path.exists(ADOPTED_PATH):
        return
    adopted = []
    for path in earlier_caches():
        try:
            with contextlib.closing(cache()) as connection:
                connection.execute("ATTACH DATABASE ? AS earlier", (path,))
                tables = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM earlier.sqlite_master WHERE type = 'table'"
                    )
                }
                with connection:
                    if "start_point" in tables:
                        connection.execute(
                            "INSERT OR IGNORE INTO start_point "
                            "(scene_id, start_s, duration_s, model, scores, computed_at) "
                            "SELECT scene_id, start_s, duration_s, model, scores, computed_at "
                            "FROM earlier.start_point"
                        )
                    if "user_start" in tables:
                        connection.execute(
                            "INSERT INTO user_start (scene_id, start_s, duration_s, "
                            "computed_start_s, computed_model, marked_at) "
                            "SELECT scene_id, start_s, duration_s, computed_start_s, "
                            "computed_model, marked_at FROM earlier.user_start WHERE true "
                            "ON CONFLICT(scene_id) DO UPDATE SET start_s = excluded.start_s, "
                            "duration_s = excluded.duration_s, "
                            "computed_start_s = excluded.computed_start_s, "
                            "computed_model = excluded.computed_model, "
                            "marked_at = excluded.marked_at "
                            "WHERE excluded.marked_at > user_start.marked_at"
                        )
            adopted.append(path)
        except sqlite3.Error as error:
            sys.stderr.write(f"\x01w\x02Auto Seek couldn't read an earlier cache {path}: {error}\n")
    write_json(ADOPTED_PATH, {"from": adopted, "at": now()})
    if adopted:
        sys.stderr.write(
            f"\x01i\x02Auto Seek kept the start points and marks of an earlier install: "
            f"{', '.join(adopted)}\n"
        )


def chart(scores: str) -> dict:
    """The frames behind a start point, for the player's chart: [time, score]
    pairs and the threshold they were judged against. Results saved before
    times were kept (bare scores) have none."""
    try:
        samples = [pair for pair in json.loads(scores or "[]") if isinstance(pair, list)]
    except ValueError:
        samples = []
    return {"samples": samples, "threshold": RULE["threshold"]} if samples else {}


def get_points(args: dict) -> dict:
    ids = [str(value) for value in args.get("scene_ids") or []][:500]
    if not ids or not os.path.isfile(CACHE_PATH):
        return {}
    marks = ",".join("?" * len(ids))
    with contextlib.closing(cache()) as connection:
        rows = connection.execute(
            "SELECT scene_id, start_s, duration_s, model, computed_at, scores FROM start_point "
            f"WHERE scene_id IN ({marks})",
            ids,
        ).fetchall()
        marked = connection.execute(
            "SELECT scene_id, start_s, duration_s, marked_at FROM user_start "
            f"WHERE scene_id IN ({marks})",
            ids,
        ).fetchall()
    points = {
        scene_id: {
            "start": start,
            "duration": duration,
            "model": model,
            "computed_at": computed_at,
            **chart(scores),
        }
        for scene_id, start, duration, model, computed_at, scores in rows
    }
    # A start the viewer marked wins over a computed one, whatever the model.
    for scene_id, start, duration, marked_at in marked:
        points[scene_id] = {
            **points.get(scene_id, {}),
            "start": start,
            "duration": duration,
            "model": "user",
            "computed_at": marked_at,
        }
    return points


def put_point(args: dict) -> dict:
    scene_id = str(args["scene_id"])
    start = float(args["start"])
    duration = float(args["duration"])
    if not 0 <= start <= duration:
        raise ValueError("start must lie within the scene")
    # Every frame the search looked at, as [time, score]: the player draws them.
    scores = json.dumps(
        [[round(float(t), 2), round(float(p), 4)] for t, p in args.get("scores") or []][:200]
    )
    with contextlib.closing(cache()) as connection, connection:
        connection.execute(
            "INSERT INTO start_point (scene_id, start_s, duration_s, model, scores, computed_at) "
            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scene_id) DO UPDATE SET "
            "start_s = excluded.start_s, duration_s = excluded.duration_s, model = excluded.model, "
            "scores = excluded.scores, computed_at = excluded.computed_at",
            (scene_id, start, duration, str(args.get("model") or ""), scores, now()),
        )
    return {"scene_id": scene_id, "start": start}


# ── frames ────────────────────────────────────────────────────────────────

FRAMES_PER_RUN = 3
FRAME_TIMEOUT_SECONDS = 30
# ffmpeg runs allowed at once across every operation on this server. Each
# input holds a decoder: about 60 MB at 1080p with one thread, twice that with
# ffmpeg's default thread count. Unbounded, a burst of requests can exhaust
# a NAS's memory and take Stash down with it.
FFMPEG_SLOTS = 4
SLOT_WAIT_SECONDS = 60
SCENE_QUERY = """
query AutoSeekScene($id: ID!) {
  findScene(id: $id) { files { path duration } }
  configuration {
    general { ffmpegPath previewSegments previewExcludeStart previewExcludeEnd }
    plugins(include: ["auto-seek"])
  }
}
"""


def stash_query(server: dict, query: str, variables: dict) -> dict:
    """One GraphQL call back to the Stash that started this process."""
    host = server.get("Host") or "127.0.0.1"
    if host == "0.0.0.0":
        host = "127.0.0.1"
    url = f"{server.get('Scheme') or 'http'}://{host}:{server.get('Port') or 9999}/graphql"
    request = urllib.request.Request(
        url,
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={"Content-Type": "application/json"},
    )
    cookie = server.get("SessionCookie") or {}
    if cookie.get("Name") and cookie.get("Value"):
        request.add_header("Cookie", f"{cookie['Name']}={cookie['Value']}")
    # Stash passes its own proxy settings to plugins; a call to itself must
    # not go through them.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=30) as response:
        payload = json.load(response)
    if payload.get("errors"):
        raise ValueError(payload["errors"][0].get("message") or "Stash query failed")
    return payload["data"]


def find_ffmpeg(configured: str, server: dict) -> str:
    """Stash's configured ffmpeg, else the one on PATH, else the copy Stash
    downloads into its config folder."""
    candidates = [configured, shutil.which("ffmpeg")]
    if server.get("Dir"):
        name = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
        candidates.append(os.path.join(server["Dir"], name))
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    raise ValueError("ffmpeg was not found")


def try_lock(handle) -> bool:
    try:
        if sys.platform == "win32":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    return True


@contextlib.contextmanager
def ffmpeg_slot():
    """Hold one of FFMPEG_SLOTS lock files while ffmpeg runs. The operating
    system drops the lock when the holder exits, even if it crashes."""
    os.makedirs(DATA_DIR, exist_ok=True)
    deadline = time.monotonic() + SLOT_WAIT_SECONDS
    while True:
        for slot in range(FFMPEG_SLOTS):
            handle = open(os.path.join(DATA_DIR, f"ffmpeg-{slot}.lock"), "a+b")  # noqa: SIM115
            if try_lock(handle):
                try:
                    yield
                finally:
                    handle.close()  # closing releases the lock
                return
            handle.close()
        if time.monotonic() > deadline:
            raise TimeoutError("The server is busy cutting frames; try again shortly")
        time.sleep(0.05)


def grab_frames(ffmpeg: str, path: str, times: list[float]) -> list[bytes | None]:
    """The frames at `times` as the model takes them: short side scaled to
    224, centre square, raw RGB. One ffmpeg run, one input per time, each
    seeking on its own; None where the video has no frame. A time past the end
    fails only its own output, so every file is read on its own and the exit
    status is not trusted."""
    size = ort_api.FRAME_SIZE
    with tempfile.TemporaryDirectory(prefix="auto-seek-") as folder:
        inputs: list[str] = []
        outputs: list[str] = []
        for i, time_s in enumerate(times):
            inputs += ["-threads", "1", "-ss", f"{time_s:.3f}", "-i", path]
            outputs += [
                "-map", f"{i}:v:0", "-frames:v", "1", "-an", "-sn",
                "-vf", f"scale={size}:{size}:force_original_aspect_ratio=increase,"
                f"crop={size}:{size}",
                "-pix_fmt", "rgb24", "-f", "rawvideo", os.path.join(folder, f"{i}.rgb"),
            ]  # fmt: skip
        command = [
            ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            *inputs,
            *outputs,
        ]
        with ffmpeg_slot(), contextlib.suppress(subprocess.TimeoutExpired):
            subprocess.run(command, capture_output=True, timeout=FRAME_TIMEOUT_SECONDS, check=False)
        frames: list[bytes | None] = []
        for i in range(len(times)):
            try:
                with open(os.path.join(folder, f"{i}.rgb"), "rb") as image:
                    data = image.read()
            except OSError:
                data = b""
            frames.append(data if len(data) == ort_api.FRAME_BYTES else None)
        return frames


def frame_preview(args: dict, server: dict) -> dict:
    """One exact frame as a small JPEG, for the strip's hover preview."""
    scene_id = str(int(args["scene_id"]))
    time_s = max(0.0, float(args["time"]))
    data = stash_query(server, SCENE_QUERY, {"id": scene_id})
    files = (data.get("findScene") or {}).get("files") or []
    if not files:
        raise ValueError("This scene has no video file")
    general = data["configuration"].get("general") or {}
    ffmpeg = find_ffmpeg(general.get("ffmpegPath") or "", server)
    with tempfile.TemporaryDirectory(prefix="auto-seek-") as folder:
        out = os.path.join(folder, "frame.jpg")
        command = [
            ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-threads", "1", "-ss", f"{time_s:.3f}", "-i", files[0]["path"],
            "-frames:v", "1", "-an", "-sn", "-vf", "scale=320:-2", "-q:v", "5", out,
        ]  # fmt: skip
        with ffmpeg_slot(), contextlib.suppress(subprocess.TimeoutExpired):
            subprocess.run(command, capture_output=True, timeout=FRAME_TIMEOUT_SECONDS, check=False)
        try:
            with open(out, "rb") as image:
                return {"time": time_s, "jpeg": base64.b64encode(image.read()).decode()}
        except OSError:
            return {"time": time_s, "jpeg": None}


def blank(pixels: bytes) -> bool:
    """A grab whose RGB values barely vary (all black, or one flat colour)
    says nothing about the scene. Every 16th pixel is enough."""
    sample = pixels[0::48] + pixels[1::48] + pixels[2::48]
    return max(sample) - min(sample) < 12


# ── the search ────────────────────────────────────────────────────────────

# Tuned on hand-checked start points with the real search below and the act
# models (210 scenes; "oral, hands or sex": 82% within 60 s of the checked
# start, against 67% for the previous model).
RULE = {
    "threshold": 0.8,  # a frame at or above this counts as started
    # A frame counts only as sure as the one this many seconds later: a single
    # frame that looks like the stage (a cutaway, a teaser in the intro) no
    # longer passes for the start (+4 points, +12 for "kissing or later").
    "pair_s": 10,
    # At least one coarse frame per this many seconds, so a long scene isn't
    # sampled more thinly than a short one.
    "segment_s": 90,
    "window_low": 0.5,  # the scan widens back over coarse frames this likely
    # A "maybe" frame just before the jump: the start may lie before it, so the
    # scan starts one sample earlier (+2 points on the checked scenes, 4 won,
    # 0 lost, under half a frame more per scene).
    "maybe": 0.3,
    "window_high": 0.8,  # ...and forward over ones not yet this sure
    "scan_min_step_s": 15,
    "scan_max_frames": 8,
    "coarse_sure": 0.95,  # the coarse pass ends after a run of frames this sure
    "coarse_sure_run": 2,
    "refine_depth": 3,  # bisection rounds between the last miss and first hit
}
EMPTY_FRAMES = "Too many frames of this scene came out blank to analyse it"


def parse_exclude(value, duration: float) -> float:
    """Stash's preview exclusions are seconds ("12") or a share ("5%")."""
    text = str(value if value is not None else "0").strip()
    try:
        number = float(text.rstrip("%") or 0)
    except ValueError:
        number = 0.0
    return duration * number / 100 if text.endswith("%") else number


def coarse_times(duration: float, config: dict, rule: dict = RULE) -> list[float]:
    """Where Stash's preview samples the scene: its segments (more for a long
    scene, see "segment_s"), spaced evenly between the exclusions."""
    segments = max(1, int(config.get("previewSegments") or 12))
    if rule.get("segment_s"):
        segments = max(segments, math.ceil(duration / rule["segment_s"]))
    start = parse_exclude(config.get("previewExcludeStart"), duration)
    end = parse_exclude(config.get("previewExcludeEnd"), duration)
    step = max(0.0, duration - start - end) / segments
    return [start + i * step for i in range(segments)]


def change_point(probs: list[float]) -> int:
    """The split that best separates "not started" from "started": the index
    that maximises the log-likelihood of all earlier frames being intro and
    all later ones action."""
    clipped = [min(1 - 1e-4, max(1e-4, p)) for p in probs]
    best, best_score = 0, -math.inf
    for i in range(len(clipped)):
        score = sum(math.log(1 - p) if j < i else math.log(p) for j, p in enumerate(clipped))
        if score > best_score:
            best, best_score = i, score
    return best


def scan_window(
    times: list[float], probs: list[float], rule: dict, origin: float | None = None
) -> tuple[float, float]:
    """The stretch to scan: from the change point, widened backwards over
    frames that already look likely and forwards over ones not yet sure.
    When the jump is already at the first frame scored, the start may lie
    anywhere before it, so the scan begins at `origin` (where sampling
    began, usually 0:00; the first sample can be a blank opening frame).
    The change point is the first frame that is clearly started, when there
    is one: with acts that come and go, a later dip no longer pulls the split
    past the real start."""
    index = next((i for i, p in enumerate(probs) if p >= rule["window_high"]), None)
    if index is None:
        index = change_point(probs)
    if index == 0 and origin is not None and origin < times[0]:
        high = 0
        while high < len(probs) - 1 and probs[high] < rule["window_high"]:
            high += 1
        return origin, times[high]
    low = index - 1
    while low > 0 and probs[low - 1] >= rule["window_low"]:
        low -= 1
    if low > 0 and probs[low] >= rule.get("maybe", 1.0):
        low -= 1
    high = index
    while high < len(probs) - 1 and probs[high] < rule["window_high"]:
        high += 1
    return times[max(low, 0)], times[high]


def scan_times(start: float, end: float, rule: dict) -> list[float]:
    if not end > start:
        return [end]
    step = max(rule["scan_min_step_s"], (end - start) / rule["scan_max_frames"])
    times, t = [], start
    while t <= end + 1e-6 and len(times) <= rule["scan_max_frames"]:
        times.append(t)
        t += step
    return times


def bisect_times(miss: float, hit: float, depth: int) -> list[float]:
    """The points a bisection `depth` rounds deep could visit between a frame
    below the threshold and the next above it; none when they are close."""
    if hit - miss < 8:
        return []
    parts = 2**depth
    return [miss + (hit - miss) * (i + 1) / parts for i in range(parts - 1)]


def search(
    score_at,
    duration: float,
    config: dict,
    rule: dict = RULE,
    eager: bool = False,
    on_phase=None,
) -> tuple[float, list[tuple[float, float]]]:
    """The start point, and every frame it looked at as (time, score). `score_at(times)` cuts
    and scores frames, returning None for a blank one; it is called in time
    order with small batches, so the search can stop early. `eager` asks for
    each pass's frames all at once instead, so they can be cut in parallel:
    the same answer, sooner, for a few more frames' work. `on_phase(name)`
    hears which pass is running: sampling, zooming, pinpointing."""
    seen: list[tuple[float, float]] = []
    phase = on_phase or (lambda name: None)

    def frames(times: list[float]):
        if eager:
            yield from zip(times, score_at(times), strict=True)
            return
        for i in range(0, len(times), FRAMES_PER_RUN):
            batch = times[i : i + FRAMES_PER_RUN]
            yield from zip(batch, score_at(batch), strict=True)

    phase("sampling")
    # Coarse pass: once a few frames in a row are clearly past the start, the
    # later ones can't move the answer.
    coarse_t: list[float] = []
    coarse: list[float] = []
    looked = sure = 0
    for t, score in frames(coarse_times(duration, config, rule)):
        looked += 1
        if score is not None:
            coarse_t.append(t)
            coarse.append(score)
        sure = sure + 1 if score is not None and score >= rule["coarse_sure"] else 0
        if sure >= rule["coarse_sure_run"]:
            break
    # With too many blank grabs the answer would come from position alone.
    if len(coarse) * 2 < looked:
        raise ValueError(EMPTY_FRAMES)
    seen += list(zip(coarse_t, coarse, strict=True))
    phase("zooming")
    # Fine pass over the window, in time order, stopping at the first hit.
    plan = coarse_times(duration, config, rule)
    low, high = scan_window(coarse_t, coarse, rule, origin=plan[0] if plan else None)
    start, last_miss = high, None
    found = False
    for t, score in frames(scan_times(low, high, rule)):
        if score is None:
            continue
        seen.append((t, score))
        if score >= rule["threshold"]:
            start, found = t, True
            break
        last_miss = t
    # The start lies between the last miss and the first hit: bisect the gap.
    if found and last_miss is not None:
        phase("pinpointing")
        points = bisect_times(last_miss, start, rule["refine_depth"])
        known = dict(zip(points, score_at(points), strict=True)) if eager and points else {}
        low_i, high_i = 0, len(points) - 1
        while low_i <= high_i:
            middle = (low_i + high_i) // 2
            point = points[middle]
            score = known[point] if point in known else score_at([point])[0]
            if score is not None:
                seen.append((point, score))
            if score is not None and score >= rule["threshold"]:
                start = point
                high_i = middle - 1
            else:
                low_i = middle + 1
    # No frame anywhere looked started: there is no start to skip to. Falling
    # back to the end of the window jumped to near the end of the scene, and
    # this happens most when the action runs from the first frame.
    if not found and all(score < rule["threshold"] for _, score in seen):
        start = plan[0] if plan else 0.0
    return start, seen


# ── analysis ──────────────────────────────────────────────────────────────

_scorer: dict = {}
LOAD_TIMES: dict = {}  # how long the model took to load in this process


def model_bytes() -> bytes:
    """The model, from a copy in the system's temporary folder when there is
    one. Plugin folders often sit on a network share (Stash's config volume on
    a NAS), where reading 89 MB took 9 s against a fraction of a second from
    local disk, and every player request is a new process that reads it again."""
    local = os.path.join(tempfile.gettempdir(), "auto-seek", MODEL["sha256"][:16] + ".onnx")
    with contextlib.suppress(OSError):
        if os.path.getsize(local) == MODEL["size"]:
            with open(local, "rb") as source:
                return source.read()
    with open(target_of(MODEL), "rb") as source:
        model = source.read()
    with contextlib.suppress(OSError):  # no local copy: read from the share next time too
        os.makedirs(os.path.dirname(local), mode=0o700, exist_ok=True)
        temporary = f"{local}.{os.getpid()}.tmp"
        with open(temporary, "wb") as out:
            out.write(model)
        os.replace(temporary, local)
        for name in os.listdir(os.path.dirname(local)):  # an older model's copy
            if name.endswith(".onnx") and name != os.path.basename(local):
                os.remove(os.path.join(os.path.dirname(local), name))
    return model


class FilesMissing(ValueError):
    """The model or ONNX Runtime isn't on the server (yet)."""


def scorer(threads: int, download: bool = True) -> ort_api.Session:
    """The chosen model, loaded once per process. Missing files start the
    download unless `download` is off (the viewer turned downloads off)."""
    key = (MODEL["path"], threads)
    if key not in _scorer:
        started = time.monotonic()
        verified = read_json(VERIFIED_PATH, {})
        runtime = RUNTIMES.get(platform_key() or "")
        if runtime is None:
            raise ValueError(
                f"Auto Seek can't run on this server ({sys.platform}, {platform.machine()})"
            )
        if not all(file_ready(entry, verified) for entry in (MODEL, runtime)):
            if not download:
                raise FilesMissing(
                    "The model isn't downloaded: downloads are turned off in Auto Seek's settings"
                )
            ensure()
            raise FilesMissing("The model is still downloading on the server")
        model = model_bytes()
        read = time.monotonic()
        _scorer.clear()
        _scorer[key] = ort_api.Session(target_of(runtime), model, threads, len(ACTS))
        LOAD_TIMES.update(read=read - started, session=time.monotonic() - read)
    return _scorer[key]


def stage_acts(stage: str) -> tuple[str, ...]:
    """The acts a stage from stage_of() counts as started."""
    if stage.startswith("acts:"):
        return tuple(ACTS[int(index)] for index in stage[5:].split("-"))
    return STAGES[stage]


def stage_score(acts: list[float], stage: str) -> float:
    """The chance that a frame shows any of the stage's acts, from the
    model's chance for each act."""
    missing = 1.0
    for act in stage_acts(stage):
        missing *= 1 - acts[ACTS.index(act)]
    return 1 - missing


def current_choice(settings: dict) -> tuple[str, str, str]:
    """The model size, the stage and the id results are cached under, and
    the download switched to that size."""
    size, stage = size_of(settings), stage_of(settings)
    choose(size)
    return size, stage, model_id(size, stage)


def plugin_settings(config: dict) -> dict:
    return (config.get("plugins") or {}).get(PLUGIN_ID) or {}


def threads_setting(settings: dict) -> int:
    try:
        return max(1, min(16, int(settings.get("threads") or 2)))
    except (TypeError, ValueError):
        return 2


class Frames:
    """Cuts frames of one scene and scores every act on them, each frame
    once; `acts[t]` is the scores (None for a blank grab)."""

    def __init__(self, session, ffmpeg: str, path: str, duration: float):
        self.session, self.ffmpeg, self.path, self.duration = session, ffmpeg, path, duration
        self.acts: dict[float, list[float] | None] = {}
        self.timings = {"cut": 0.0, "score": 0.0}

    def score(self, times) -> None:
        times = sorted({round(t, 2) for t in times} - set(self.acts))
        if not times:
            return
        t0 = time.monotonic()
        groups = [times[i : i + FRAMES_PER_RUN] for i in range(0, len(times), FRAMES_PER_RUN)]
        if len(groups) > 1:
            with ThreadPoolExecutor(min(FFMPEG_SLOTS, len(groups))) as pool:
                batches = pool.map(lambda group: grab_frames(self.ffmpeg, self.path, group), groups)
                grabs = [frame for batch in batches for frame in batch]
        else:
            grabs = grab_frames(self.ffmpeg, self.path, times)
        t1 = time.monotonic()
        d = self.duration
        for t, pixels in zip(times, grabs, strict=True):
            acts = None
            if pixels is not None and not blank(pixels):
                acts = list(self.session.score(pixels, [t / d, t / 60, d / 3600])[1])
            self.acts[t] = acts
        self.timings["cut"] += t1 - t0
        self.timings["score"] += time.monotonic() - t1


# ── act timeline ──────────────────────────────────────────────────────────

# After the start, the background worker scores frames across the whole
# scene, left to right, saving every few frames so the page follows it, and finds
# where each act first shows: its first frame past the threshold (as sure as
# the frame `pair_s` later, as for the start), narrowed down by bisection.
TIMELINE = {
    "spacing_s": 10,
    "threshold": RULE["threshold"],
    "pair_s": RULE["pair_s"],
    "refine_s": 2.5,
}
TIMELINE_BATCH = FFMPEG_SLOTS  # saved after every few frames, so the page follows closely


def timeline_spacing(settings: dict) -> float:
    try:
        value = float(settings.get("timelineSpacing") or TIMELINE["spacing_s"])
    except (TypeError, ValueError):
        value = TIMELINE["spacing_s"]
    return max(2.0, min(120.0, value))


def timeline_on(settings: dict) -> bool:
    return settings.get("disableTimeline") is not True


def timeline_id(size: str, spacing: float) -> str:
    return f"{MODELS[size]['id']}/x{spacing:g}+t80p10"


def timeline_grid(duration: float, spacing: float) -> list[float]:
    """The scan's frames, left to right (the page shows where it has got to)."""
    count = max(1, math.ceil((duration - 1) / spacing))
    return [round(k * spacing, 2) for k in range(count)]


def partner_of(t: float, duration: float, pair: float) -> float:
    return round(max(t, min(t + pair, duration - 1)), 2)


def act_hits(acts: dict, duration: float, rule: dict = TIMELINE) -> dict[str, tuple]:
    """For each act: (last frame before its first hit, first hit), from the
    frames scored so far. A hit is a frame past the threshold whose partner
    (if scored and not blank) is too."""
    times = sorted(t for t, a in acts.items() if a is not None)
    out = {}
    for j, act in enumerate(ACTS):
        if j == 0:
            continue  # "nothing yet" has no start
        before = None
        for t in times:
            later = acts.get(partner_of(t, duration, rule["pair_s"]))
            score = acts[t][j] if later is None else min(acts[t][j], later[j])
            if score >= rule["threshold"]:
                out[act] = (before, t)
                break
            before = t
    return out


def save_timeline(scene_id, model, duration, acts, firsts, state, error=None) -> None:
    frames = [
        [t, None if a is None else [round(100 * v) for v in a]] for t, a in sorted(acts.items())
    ]
    with contextlib.closing(cache()) as connection, connection:
        connection.execute(
            "INSERT OR REPLACE INTO timeline (scene_id, model, duration_s, frames, firsts, state, "
            "error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(scene_id), model, duration, json.dumps(frames, separators=(",", ":")),
                json.dumps(firsts), state, error, now(),
            ),
        )  # fmt: skip


def load_timeline(scene_id: str) -> dict | None:
    if not os.path.isfile(CACHE_PATH):
        return None
    with contextlib.closing(cache()) as connection:
        row = connection.execute(
            "SELECT model, duration_s, frames, firsts, state, error, updated_at FROM timeline "
            "WHERE scene_id = ?",
            (str(scene_id),),
        ).fetchone()
    if row is None:
        return None
    model, duration, frames, firsts, state, error, updated = row
    return {
        "model": model,
        "duration": duration,
        "frames": json.loads(frames),
        "firsts": json.loads(firsts),
        "state": state,
        "error": error,
        "updated_at": updated,
    }


def stored_acts(row: dict | None, model: str) -> dict:
    """The act scores a saved timeline holds, if the same model made them
    (another spacing or rule still reuses its frames)."""
    if not row or row["model"].split("/")[0] != model.split("/")[0]:
        return {}
    return {t: None if a is None else [v / 100 for v in a] for t, a in row["frames"]}


class Paused(Exception):
    """A page asked for another scene's timeline: this scan waits."""


def page_waiting(scene_id: str) -> bool:
    """Whether a page asked for another scene since this one was queued."""
    with contextlib.closing(cache()) as connection:
        own = connection.execute(
            "SELECT priority FROM pending WHERE scene_id = ?", (scene_id,)
        ).fetchone()
        top = connection.execute(
            "SELECT scene_id, priority FROM pending ORDER BY priority DESC, added_at LIMIT 1"
        ).fetchone()
    return bool(top and top[0] != scene_id and top[1] > (own[0] if own else 0))


def scan_timeline(scene_id: str, server: dict, yields: bool = False) -> dict:
    """Score the whole scene for the act timeline, saving as it goes so the
    page can draw it live. `yields` (the background worker): stop for a
    scene a page asked for since, keeping the frames for later."""
    data = stash_query(server, SCENE_QUERY, {"id": scene_id})
    files = (data.get("findScene") or {}).get("files") or []
    if not files or not files[0].get("duration"):
        raise ValueError("This scene has no video file")
    path, duration = files[0]["path"], float(files[0]["duration"])
    config = data["configuration"]
    settings = plugin_settings(config)
    size, _, _ = current_choice(settings)
    spacing = timeline_spacing(settings)
    model = timeline_id(size, spacing)
    row = load_timeline(scene_id)
    if row and row["model"] == model and row["state"] == 1:
        return row
    session = scorer(threads_setting(settings), settings.get("disableDownload") is not True)
    ffmpeg = find_ffmpeg((config.get("general") or {}).get("ffmpegPath") or "", server)
    frames = Frames(session, ffmpeg, path, duration)
    frames.acts.update(stored_acts(row, model))
    pair = TIMELINE["pair_s"]
    try:
        grid = timeline_grid(duration, spacing)
        for i in range(0, len(grid), TIMELINE_BATCH):
            batch = grid[i : i + TIMELINE_BATCH]
            frames.score([*batch, *(partner_of(t, duration, pair) for t in batch)])
            save_timeline(scene_id, model, duration, frames.acts, {}, 0)
            if yields and page_waiting(scene_id):
                save_timeline(scene_id, model, duration, frames.acts, {}, 3)
                raise Paused(scene_id)
        # Narrow each act's first hit down to a few seconds: one middle frame
        # per act and round, all acts' frames cut together.
        spans = {act: list(span) for act, span in act_hits(frames.acts, duration).items()}
        while True:
            open_spans = {
                act: span
                for act, span in spans.items()
                if span[0] is not None and span[1] - span[0] > TIMELINE["refine_s"]
            }
            if not open_spans:
                break
            middles = {act: round((lo + hi) / 2, 2) for act, (lo, hi) in open_spans.items()}
            frames.score(
                [*middles.values(), *(partner_of(t, duration, pair) for t in middles.values())]
            )
            j_of = {act: ACTS.index(act) for act in middles}
            for act, t in middles.items():
                a, later = frames.acts.get(t), frames.acts.get(partner_of(t, duration, pair))
                if a is None:
                    spans[act][0] = t  # blank: can't tell; look later
                    continue
                score = a[j_of[act]] if later is None else min(a[j_of[act]], later[j_of[act]])
                spans[act][1 if score >= TIMELINE["threshold"] else 0] = t
        firsts = {act: span[1] for act, span in sorted(spans.items(), key=lambda kv: kv[1][1])}
        save_timeline(scene_id, model, duration, frames.acts, firsts, 1)
    except (FilesMissing, Paused):
        raise
    except Exception as error:
        save_timeline(scene_id, model, duration, frames.acts, {}, 2, str(error)[:500])
        raise
    return load_timeline(scene_id) or {}


def analyse_scene(scene_id: str, server: dict, eager: bool = False) -> dict:
    """Find the start of one scene and cache it. `eager` (someone is waiting
    for it) cuts each pass's frames in parallel."""
    started = time.monotonic()
    data = stash_query(server, SCENE_QUERY, {"id": scene_id})
    queried = time.monotonic()
    files = (data.get("findScene") or {}).get("files") or []
    if not files or not files[0].get("duration"):
        raise ValueError("This scene has no video file")
    path, duration = files[0]["path"], float(files[0]["duration"])
    config = data["configuration"]
    general = config.get("general") or {}
    live: list[list[float]] = []
    status = {"phase": "loading"}
    if eager:  # someone is watching the strip
        write_progress(scene_id, duration, live, "loading")
    settings = plugin_settings(config)
    _, stage, current_id = current_choice(settings)
    try:
        session = scorer(threads_setting(settings), settings.get("disableDownload") is not True)
    except Exception:
        # e.g. still downloading: the player should see the download instead
        with contextlib.suppress(OSError):
            os.remove(progress_path(scene_id))
        raise
    ffmpeg = find_ffmpeg(general.get("ffmpegPath") or "", server)
    frames = Frames(session, ffmpeg, path, duration)
    timings = frames.timings

    def on_phase(name: str) -> None:
        status["phase"] = name
        if eager:
            write_progress(scene_id, duration, live, name)

    pair = RULE.get("pair_s") or 0

    def partner(t: float) -> float:
        return partner_of(t, duration, pair)

    def stage_at(t: float) -> float | None:
        acts = frames.acts[round(t, 2)]
        return None if acts is None else stage_score(acts, stage)

    def score_at(times: list[float]) -> list[float | None]:
        # Each frame with its partner a few seconds later: a frame is only as
        # sure as the less sure of the two (a blank partner doesn't count).
        frames.score([*times, *(partner(t) for t in times)] if pair else times)
        out: list[float | None] = []
        for t in times:
            score, later = stage_at(t), stage_at(partner(t)) if pair else None
            if score is not None and later is not None:
                score = min(score, later)
            if score is not None:
                live.append([round(t, 2), round(score, 4)])
                if eager:  # someone is watching the strip fill in
                    write_progress(scene_id, duration, live, status["phase"])
            out.append(score)
        return out

    try:
        start, scores = search(score_at, duration, general, eager=eager, on_phase=on_phase)
    finally:
        with contextlib.suppress(OSError):
            os.remove(progress_path(scene_id))
    put_point(
        {
            "scene_id": scene_id,
            "start": start,
            "duration": duration,
            "model": current_id,
            # Every frame scored, including ones cut in a batch that the
            # search ended up not needing: the player shows them all, and the
            # live view it drew while waiting must not lose bars afterwards.
            "scores": [(t, p) for t, p in live],
        }
    )
    with contextlib.closing(cache()) as connection, connection:
        connection.execute("DELETE FROM failure WHERE scene_id = ?", (scene_id,))
    # The frames the search scored start the scene's timeline off.
    if timeline_on(settings):
        with contextlib.suppress(sqlite3.Error, OSError):
            model = timeline_id(size_of(settings), timeline_spacing(settings))
            row = load_timeline(scene_id)
            if not (row and row["model"] == model and row["state"] == 1):
                seed = stored_acts(row, model) | frames.acts
                save_timeline(scene_id, model, duration, seed, {}, 3)
    return {
        "start": start,
        "duration": duration,
        "model": current_id,
        "frames": len(scores),
        "samples": live,
        "threshold": RULE["threshold"],
        "timings_ms": {
            key: round(value * 1000)
            for key, value in (timings | {"query": queried - started} | LOAD_TIMES).items()
        }
        | {"total": round((time.monotonic() - started) * 1000)},
    }


def progress_path(scene_id: str) -> str:
    return os.path.join(DATA_DIR, "progress", f"{int(scene_id)}.json")


def write_progress(scene_id: str, duration: float, samples: list, phase: str = "") -> None:
    """The frames scored so far and the pass running, for the player's strip
    while it waits."""
    with contextlib.suppress(OSError, ValueError):
        write_json(
            progress_path(scene_id),
            {
                "duration": duration,
                "threshold": RULE["threshold"],
                "samples": samples,
                "phase": phase,
            },
        )


def scan_progress(args: dict) -> dict:
    """What an analysis running in another process is doing: the first-use
    download (with bytes so far), or the pass running and the frames scored."""
    path = progress_path(str(args["scene_id"]))
    with contextlib.suppress(OSError):
        if time.time() - os.path.getmtime(path) < 300:
            return read_json(path, {})
    current = status()
    if not current["ready"] and current["supported"]:
        return {
            "phase": "downloading" if current["downloading"] else "waiting-download",
            "received": current["received"],
            "total": current["total"],
            "error": current["error"],
        }
    return {}


SETTINGS_QUERY = '{ configuration { plugins(include: ["auto-seek"]) } }'


def settings_now(server: dict) -> dict:
    return plugin_settings(stash_query(server, SETTINGS_QUERY, {})["configuration"])


def record_failure(scene_id: str, error: Exception, current_id: str) -> None:
    with contextlib.closing(cache()) as connection, connection:
        connection.execute(
            "INSERT OR REPLACE INTO failure (scene_id, model, error, failed_at) "
            "VALUES (?, ?, ?, ?)",
            (scene_id, current_id, str(error)[:500], now()),
        )


def analyse(args: dict, server: dict) -> dict:
    """The player's request: the cached start, or one worked out now."""
    scene_id = str(args["scene_id"])
    point = get_points({"scene_ids": [scene_id]}).get(scene_id)
    # A start from another model or stage, or saved before frame times were
    # kept, is worked out again; a start the viewer marked always stands.
    current = point and (
        point["model"] == "user"
        or (point["model"] == current_choice(settings_now(server))[2] and point.get("samples"))
    )
    if current and not args.get("force"):
        return point
    return analyse_scene(scene_id, server, eager=True)


def done_ids(ids: list[str], current_id: str) -> set[str]:
    """Scenes with a current answer (computed by this model for this stage,
    marked by the viewer, or failed with it)."""
    if not ids or not os.path.isfile(CACHE_PATH):
        return set()
    marks = ",".join("?" * len(ids))
    with contextlib.closing(cache()) as connection:
        rows = connection.execute(
            f"SELECT scene_id FROM start_point WHERE model = ? AND scene_id IN ({marks}) "
            f"UNION SELECT scene_id FROM user_start WHERE scene_id IN ({marks}) "
            f"UNION SELECT scene_id FROM failure WHERE model = ? AND scene_id IN ({marks})",
            [current_id, *ids, *ids, current_id, *ids],
        ).fetchall()
    return {row[0] for row in rows}


def lower_priority() -> None:
    with contextlib.suppress(AttributeError, OSError):
        os.nice(10)


def progress(fraction: float, message: str | None = None) -> None:
    """Stash's plugin log protocol: task progress and info lines on stderr."""
    if message:
        sys.stderr.write(f"\x01i\x02{message}\n")
    sys.stderr.write(f"\x01p\x02{max(0.0, min(1.0, fraction)):.4f}\n")
    sys.stderr.flush()


LIBRARY_QUERY = """
query AutoSeekLibrary($page: Int!) {
  findScenes(filter: { page: $page, per_page: 200, sort: "created_at", direction: DESC }) {
    count
    scenes { id }
  }
}
"""


def library_task(args: dict, server: dict) -> dict:
    """Tasks → Find start points: every scene without a current answer,
    newest first, one at a time at low priority. Stopping it loses nothing:
    each answer is saved as it is found."""
    lower_priority()
    settings = settings_now(server)
    current_id = current_choice(settings)[2]
    ids: list[str] = []
    page = 1
    while True:
        found = stash_query(server, LIBRARY_QUERY, {"page": page})["findScenes"]
        ids += [scene["id"] for scene in found["scenes"]]
        if not found["scenes"] or len(ids) >= found["count"]:
            break
        page += 1
    done = set()
    for i in range(0, len(ids), 500):
        done |= done_ids(ids[i : i + 500], current_id)
    todo = [
        scene_id
        for scene_id in ids
        if scene_id not in done or not timeline_done(scene_id, settings)
    ]
    analysed = failed = 0
    started = time.monotonic()
    progress(0, f"Auto Seek: {len(todo)} of {len(ids)} scenes to analyse")
    for n, scene_id in enumerate(todo, 1):
        # One bad file must not stop the run; the worker or the player may
        # have got there first.
        did = work_on(scene_id, server, settings)
        analysed += did not in ("", "failed")
        failed += did == "failed"
        if n % 10 == 0 or n == len(todo):
            rate = (time.monotonic() - started) / n
            progress(n / len(todo), f"Auto Seek: {n}/{len(todo)} scenes, {rate:.1f} s each")
    return {"analysed": analysed, "failed": failed, "skipped": len(ids) - len(todo)}


# ── new scenes ────────────────────────────────────────────────────────────


def hook(args: dict, server: dict) -> dict:
    """Scene.Create.Post: queue the new scene for the background worker and
    make sure one is running. Returns at once; the scan carries on."""
    scene_id = str((args.get("hookContext") or {}).get("id") or "")
    if not scene_id:
        return {}
    settings = settings_now(server)
    current_choice(settings)  # the status below is for the chosen model
    if settings.get("disableNewScenes") is True or not status()["ready"]:
        return {"queued": False}
    with contextlib.closing(cache()) as connection, connection:
        connection.execute(
            "INSERT OR IGNORE INTO pending (scene_id, added_at) VALUES (?, ?)",
            (scene_id, now()),
        )
    start_worker(server)
    return {"queued": True}


def start_worker(server: dict) -> None:
    """A detached worker, unless one holds the worker lock already. The
    connection details go over stdin, so the session cookie never touches
    the disk."""
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(WORKER_LOCK_PATH, "a+b") as handle:
        if not try_lock(handle):
            return
    options: dict = {
        "stdin": subprocess.PIPE,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if sys.platform == "win32":
        options["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    child = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), PLUGIN_DIR, "worker"], **options
    )
    child.stdin.write(json.dumps(server).encode())
    child.stdin.close()


def timeline_done(scene_id: str, settings: dict) -> bool:
    """Off, or scanned (or failed) with the current model and spacing."""
    if not timeline_on(settings):
        return True
    row = load_timeline(scene_id)
    model = timeline_id(size_of(settings), timeline_spacing(settings))
    return bool(row and row["model"] == model and row["state"] in (1, 2))


def work_on(scene_id: str, server: dict, settings: dict, yields: bool = False) -> str:
    """The background's work on one scene: its start if it has none, then
    its timeline. Returns what was done; a failure is recorded, not raised
    (except missing model files)."""
    current_id = current_choice(settings)[2]
    did = ""
    if scene_id not in done_ids([scene_id], current_id):
        try:
            analyse_scene(scene_id, server)
            did = "start"
        except Exception as error:
            if isinstance(error, FilesMissing) or "can't run" in str(error):
                raise
            record_failure(scene_id, error, current_id)
            return "failed"
    if not timeline_done(scene_id, settings):
        try:
            scan_timeline(scene_id, server, yields)
            did += "+timeline"
        except Exception as error:
            if isinstance(error, (FilesMissing, Paused)) or "can't run" in str(error):
                raise
            return "failed"  # kept in the timeline row (state 2)
    return did


def worker() -> None:
    """Analyse queued scenes until none are left. One worker at a time."""
    server = json.loads(sys.stdin.read() or "{}")
    lower_priority()
    with open(WORKER_LOCK_PATH, "a+b") as handle:
        if not try_lock(handle):
            return
        while True:
            with contextlib.closing(cache()) as connection:
                row = connection.execute(
                    "SELECT scene_id FROM pending ORDER BY priority DESC, added_at LIMIT 1"
                ).fetchone()
            if row is None:
                return
            scene_id = row[0]
            settings = settings_now(server)
            try:
                work_on(scene_id, server, settings, yields=True)
            except FilesMissing:
                return  # the queue keeps it for the next new scene
            except Paused:
                continue  # it stays queued, behind the scene a page asked for
            with contextlib.closing(cache()) as connection, connection:
                connection.execute("DELETE FROM pending WHERE scene_id = ?", (scene_id,))


def queue_scene(scene_id: str, server: dict, priority: int = 0) -> None:
    with contextlib.closing(cache()) as connection, connection:
        connection.execute(
            "INSERT INTO pending (scene_id, added_at, priority) VALUES (?, ?, ?) "
            "ON CONFLICT(scene_id) DO UPDATE SET priority = max(priority, excluded.priority)",
            (scene_id, now(), priority),
        )
    start_worker(server)


TIMELINE_STALE_SECONDS = 120


def timeline_view(args: dict, server: dict) -> dict:
    """The page's timeline: the frames scanned so far with every act's score
    (in percent), where each act first shows, and whether the scan is still
    running. A scene not scanned yet is queued first in line."""
    scene_id = str(args["scene_id"])
    settings = settings_now(server)
    if not timeline_on(settings):
        return {"state": "off"}
    row = load_timeline(scene_id)
    model = timeline_id(size_of(settings), timeline_spacing(settings))
    current = bool(row and row["model"] == model)
    fresh = bool(
        row
        and (
            datetime.now(UTC) - datetime.strptime(row["updated_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        ).total_seconds()
        < TIMELINE_STALE_SECONDS
    )  # fmt: skip
    if current and row["state"] in (1, 2):
        state = "done" if row["state"] == 1 else "failed"
    else:
        scanning = current and fresh and row["state"] == 0
        state = "scanning" if scanning else "queued"
        if not scanning and args.get("queue", True):
            # The scene asked for most recently goes first.
            queue_scene(scene_id, server, priority=int(time.time()))
    shown = row if current else None  # another model's frames don't show
    frames = shown["frames"] if shown else []
    firsts = shown["firsts"] if shown and state == "done" else {}
    if shown and state != "done":  # so far: each act's first frame past the threshold
        acts = {t: None if a is None else [v / 100 for v in a] for t, a in frames}
        firsts = {act: hit for act, (_, hit) in act_hits(acts, shown["duration"]).items()}
    duration = shown["duration"] if shown else None
    grid = set(timeline_grid(duration, timeline_spacing(settings))) if duration else set()
    return {
        "state": state,
        "error": shown["error"] if shown and state == "failed" else None,
        "duration": duration,
        "spacing": timeline_spacing(settings),
        "threshold": TIMELINE["threshold"],
        "acts": list(ACTS),
        "frames": frames,
        "firsts": firsts,
        "planned": len(grid),
        "scanned": len(grid & {t for t, _ in frames}),
        # How far along the scene the scan has got (it goes left to right).
        "position": max(grid & {t for t, _ in frames}, default=0),
    }


def mark_point(args: dict) -> dict:
    scene_id = str(args["scene_id"])
    start = float(args["start"])
    duration = float(args["duration"])
    if not 0 <= start <= duration:
        raise ValueError("start must lie within the scene")
    with contextlib.closing(cache()) as connection, connection:
        computed = connection.execute(
            "SELECT start_s, model FROM start_point WHERE scene_id = ?", (scene_id,)
        ).fetchone() or (None, None)
        connection.execute(
            "INSERT OR REPLACE INTO user_start (scene_id, start_s, duration_s, computed_start_s, "
            "computed_model, marked_at) VALUES (?, ?, ?, ?, ?, ?)",
            (scene_id, start, duration, *computed, now()),
        )
    return {"scene_id": scene_id, "start": start}


def unmark_point(args: dict) -> dict:
    scene_id = str(args["scene_id"])
    with contextlib.closing(cache()) as connection, connection:
        connection.execute("DELETE FROM user_start WHERE scene_id = ?", (scene_id,))
    return {"scene_id": scene_id}


def follow_settings(server: dict) -> None:
    """Switch the files to the model size the settings ask for now, so the
    player's first status call after a switch starts its download."""
    if server:
        with contextlib.suppress(Exception):  # the status works without it
            current_choice(settings_now(server))


OPERATIONS = {
    "status": lambda args, server: follow_settings(server) or status(),
    "ensure": lambda args, server: follow_settings(server) or ensure(),
    "get": lambda args, server: get_points(args),
    "analyse": analyse,
    "progress": lambda args, server: scan_progress(args),
    "timeline": timeline_view,
    "frame": frame_preview,
    "mark": lambda args, server: mark_point(args),
    "unmark": lambda args, server: unmark_point(args),
    "library": library_task,
    "hook": hook,
}


def main() -> None:
    if len(sys.argv) > 2 and sys.argv[2] == "download":
        download()
        return
    if len(sys.argv) > 2 and sys.argv[2] == "worker":
        worker()
        return
    try:
        adopt_earlier_install()
    except (OSError, sqlite3.Error) as error:
        sys.stderr.write(f"\x01w\x02Auto Seek couldn't check for an earlier install: {error}\n")
    try:
        request = json.loads(sys.stdin.read() or "{}")
        args = request.get("args") or {}
        handler = OPERATIONS.get(args.get("op"))
        if handler is None:
            raise ValueError(f"unknown operation: {args.get('op')!r}")
        reply = {"output": handler(args, request.get("server_connection") or {})}
    except Exception as error:
        reply = {"error": str(error)}
    sys.stdout.write(json.dumps(reply))


if __name__ == "__main__":
    main()
