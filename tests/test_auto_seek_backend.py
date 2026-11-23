import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "auto-seek" / "auto_seek.py"


@pytest.fixture
def backend(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["auto_seek.py", str(tmp_path)])
    spec = importlib.util.spec_from_file_location("auto_seek_under_test", BACKEND)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # The plugin's settings, as Stash would return them: the defaults.
    module.settings_now = lambda server: {}
    return module


def default_id(backend):
    return backend.model_id("fast", "oral")


def stash_segments(backend):
    """The rule with Stash's preview segments only (none added for length)."""
    return {**backend.RULE, "segment_s": 0}


@pytest.fixture
def server():
    files: dict[str, bytes] = {}
    ranges: list[str | None] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = files[self.path]
            ranges.append(self.headers.get("Range"))
            start = (
                int(self.headers["Range"].split("=")[1].rstrip("-"))
                if self.headers.get("Range")
                else 0
            )
            self.send_response(206 if start else 200)
            self.send_header("Content-Length", str(len(body) - start))
            self.end_headers()
            self.wfile.write(body[start:])

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_port}", files, ranges
    httpd.shutdown()


def entry(base, files, name, body, *, sha=None):
    files[f"/{name}"] = body
    return {
        "path": f"sub/{name}",
        "url": f"{base}/{name}",
        "sha256": sha or hashlib.sha256(body).hexdigest(),
        "size": len(body),
    }


def test_download_resumes_and_verifies(backend, server):
    base, files, ranges = server
    big = os.urandom(300_000)
    backend.FILES = (
        entry(base, files, "a.bin", big),
        entry(base, files, "b.js", b"console.log(1)"),
    )
    partial = Path(backend.FILES_DIR, "sub", "a.bin.part")
    partial.parent.mkdir(parents=True)
    partial.write_bytes(big[:100_000])
    Path(backend.LOCK_PATH).write_text("1")

    backend.download()

    assert Path(backend.FILES_DIR, "sub", "a.bin").read_bytes() == big
    assert ranges[0] == "bytes=100000-"
    assert not partial.exists() and not Path(backend.LOCK_PATH).exists()
    status = backend.status()
    assert status["ready"] and not status["downloading"] and status["received"] == status["total"]


def test_download_removes_files_an_earlier_version_pinned(backend, server):
    base, files, _ = server
    backend.FILES = (entry(base, files, "new.bin", b"new model"),)
    old = Path(backend.FILES_DIR, "sub", "old.bin")
    old.parent.mkdir(parents=True)
    old.write_bytes(b"old model")
    outside = Path(backend.DATA_DIR, "cache.sqlite3")
    outside.write_bytes(b"keep")
    Path(backend.VERIFIED_PATH).write_text(
        json.dumps({"sub/old.bin": "x", "../cache.sqlite3": "y"})
    )
    Path(backend.LOCK_PATH).write_text("1")

    backend.download()

    assert not old.exists() and outside.read_bytes() == b"keep"
    assert Path(backend.FILES_DIR, "sub", "new.bin").read_bytes() == b"new model"
    assert set(json.loads(Path(backend.VERIFIED_PATH).read_text())) == {"sub/new.bin"}
    assert backend.status()["ready"]


def test_checksum_failure_is_reported_and_not_marked_ready(backend, server):
    base, files, _ = server
    backend.FILES = (entry(base, files, "a.bin", b"tampered", sha="0" * 64),)
    Path(backend.DATA_DIR).mkdir()
    Path(backend.LOCK_PATH).write_text("1")

    backend.download()

    status = backend.status()
    assert not status["ready"] and not status["downloading"]
    assert "checksum" in status["error"]
    assert not Path(backend.FILES_DIR, "sub", "a.bin").exists()
    assert not Path(backend.FILES_DIR, "sub", "a.bin.part").exists()


def test_ensure_starts_one_detached_download(backend, server, monkeypatch):
    base, files, _ = server
    backend.FILES = (entry(base, files, "a.bin", b"x" * 10),)
    started = []
    monkeypatch.setattr(
        backend.subprocess,
        "Popen",
        lambda args, **options: started.append((args, options)),
    )

    first = backend.ensure()
    second = backend.ensure()

    assert first["downloading"] and second["downloading"]
    assert len(started) == 1
    args, options = started[0]
    assert args[-2:] == [backend.PLUGIN_DIR, "download"]
    assert options.get("start_new_session") or options.get("creationflags")


def test_abandoned_lock_allows_a_new_download(backend, server, monkeypatch):
    base, files, _ = server
    backend.FILES = (entry(base, files, "a.bin", b"x" * 10),)
    Path(backend.DATA_DIR).mkdir()
    Path(backend.LOCK_PATH).write_text("1")
    old = os.path.getmtime(backend.LOCK_PATH) - backend.LOCK_STALE_SECONDS - 5
    os.utime(backend.LOCK_PATH, (old, old))
    started = []
    monkeypatch.setattr(backend.subprocess, "Popen", lambda args, **options: started.append(args))

    assert backend.ensure()["downloading"]
    assert len(started) == 1


def test_start_point_cache_round_trip(backend):
    assert backend.get_points({"scene_ids": ["7"]}) == {}
    backend.put_point(
        {
            "scene_id": 7,
            "start": 312.5,
            "duration": 1800,
            "model": "m1",
            "scores": [(150, 0.1), (312.5, 0.9)],
        }
    )
    # The frames behind the start come back for the player's chart.
    first = backend.get_points({"scene_ids": ["7"]})["7"]
    assert first["samples"] == [[150, 0.1], [312.5, 0.9]]
    assert first["threshold"] == backend.RULE["threshold"]
    backend.put_point({"scene_id": 7, "start": 300, "duration": 1800, "model": "m2"})

    point = backend.get_points({"scene_ids": [7, 8]})
    assert list(point) == ["7"]
    assert point["7"]["start"] == 300 and point["7"]["model"] == "m2"
    with pytest.raises(ValueError):
        backend.put_point({"scene_id": 7, "start": 2000, "duration": 1800})


def test_progress_shows_frames_scored_so_far(backend, monkeypatch):
    monkeypatch.setattr(backend, "status", lambda: {"ready": True, "supported": True})
    assert backend.scan_progress({"scene_id": 7}) == {}
    backend.write_progress("7", 1800.0, [[150, 0.1], [300, 0.9]])
    progress = backend.scan_progress({"scene_id": "7"})
    assert progress["samples"] == [[150, 0.1], [300, 0.9]] and progress["duration"] == 1800.0
    with pytest.raises(ValueError):
        backend.progress_path("../x")  # scene ids only


def test_results_saved_before_frame_times_have_no_chart(backend):
    assert backend.chart("[0.1, 0.9]") == {}
    assert backend.chart("") == {} and backend.chart("not json") == {}


def test_marked_start_wins_and_survives_recomputation(backend):
    backend.put_point({"scene_id": 7, "start": 300, "duration": 1800, "model": "m1"})
    backend.mark_point({"scene_id": 7, "start": 284, "duration": 1800})
    # A new model recomputes the scene; the viewer's mark still wins.
    backend.put_point({"scene_id": 7, "start": 320, "duration": 1800, "model": "m2"})
    point = backend.get_points({"scene_ids": ["7"]})["7"]
    assert (point["start"], point["model"]) == (284, "user")
    # The computed start at marking time is kept beside the mark, as a label.
    with backend.cache() as connection:
        row = connection.execute(
            "SELECT start_s, computed_start_s, computed_model FROM user_start"
        ).fetchone()
    assert row == (284, 300, "m1")
    backend.unmark_point({"scene_id": 7})
    assert backend.get_points({"scene_ids": ["7"]})["7"]["model"] == "m2"


def test_cache_from_version_1_gains_the_marks_table(backend):
    import sqlite3

    os.makedirs(backend.DATA_DIR, exist_ok=True)
    with sqlite3.connect(backend.CACHE_PATH) as connection:
        connection.executescript(
            "CREATE TABLE start_point (scene_id TEXT PRIMARY KEY, start_s REAL NOT NULL, "
            "duration_s REAL NOT NULL, model TEXT NOT NULL, scores TEXT NOT NULL DEFAULT '[]', "
            "computed_at TEXT NOT NULL);"
            "INSERT INTO start_point VALUES ('7', 300, 1800, 'm1', '[]', 'then');"
            "PRAGMA user_version = 1;"
        )
    assert backend.get_points({"scene_ids": ["7"]})["7"]["start"] == 300
    backend.mark_point({"scene_id": 7, "start": 290, "duration": 1800})
    assert backend.get_points({"scene_ids": ["7"]})["7"]["model"] == "user"


def load_backend(plugin_dir, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["auto_seek.py", str(plugin_dir)])
    spec = importlib.util.spec_from_file_location("auto_seek_install", BACKEND)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_switching_plugin_source_keeps_start_points_and_marks(tmp_path, monkeypatch):
    # Stash installs into <plugins>/<source folder>/auto-seek; uninstalling leaves data/.
    old = load_backend(tmp_path / "plugins" / "curator" / "auto-seek", monkeypatch)
    old.put_point({"scene_id": 7, "start": 300, "duration": 1800, "model": "m1"})
    old.put_point({"scene_id": 8, "start": 100, "duration": 900, "model": "m1"})
    old.mark_point({"scene_id": 7, "start": 284, "duration": 1800})
    old.mark_point({"scene_id": 9, "start": 50, "duration": 600})

    new = load_backend(tmp_path / "plugins" / "hub" / "auto-seek", monkeypatch)
    # The new install had already analysed scene 8 itself: its own result stays.
    new.put_point({"scene_id": 8, "start": 120, "duration": 900, "model": "m2"})
    new.adopt_earlier_install()
    points = new.get_points({"scene_ids": ["7", "8", "9"]})
    assert (points["7"]["start"], points["7"]["model"]) == (284, "user")
    assert (points["8"]["start"], points["8"]["model"]) == (120, "m2")
    assert points["9"]["start"] == 50
    # Once only: later changes in the old folder aren't pulled in again.
    old.mark_point({"scene_id": 8, "start": 10, "duration": 900})
    new.adopt_earlier_install()
    assert new.get_points({"scene_ids": ["8"]})["8"]["model"] == "m2"


def test_a_source_without_a_folder_finds_the_earlier_install_too(tmp_path, monkeypatch):
    old = load_backend(tmp_path / "plugins" / "curator" / "auto-seek", monkeypatch)
    old.mark_point({"scene_id": 7, "start": 284, "duration": 1800})
    new = load_backend(tmp_path / "plugins" / "auto-seek", monkeypatch)
    new.adopt_earlier_install()
    assert new.get_points({"scene_ids": ["7"]})["7"]["start"] == 284


def test_a_fresh_install_with_nothing_to_adopt(backend):
    backend.adopt_earlier_install()
    assert backend.get_points({"scene_ids": ["7"]}) == {}
    assert os.path.exists(backend.ADOPTED_PATH)


def test_raw_interface_replies_with_output_or_error(backend, monkeypatch, capsys):
    for request, key in (
        ({"args": {"op": "status"}}, "output"),
        ({"args": {"op": "nope"}}, "error"),
    ):
        monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))
        backend.main()
        assert key in json.loads(capsys.readouterr().out)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")
def test_frames_are_cut_as_raw_model_input(backend, tmp_path):
    video = tmp_path / "scene.mp4"
    source = "testsrc=duration=4:size=640x360:rate=10"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", source, str(video)],
        check=True,
    )
    frames = backend.grab_frames(shutil.which("ffmpeg"), str(video), [1.5, 60, 3, 0.5])
    # Short side scaled to 224 and the centre square kept, as raw RGB.
    assert len(frames[0]) == 224 * 224 * 3
    assert frames[1] is None  # past the end: no frame there
    # ...without costing the other frames of the same ffmpeg run.
    assert frames[2] and frames[3] and frames[2] != frames[3]
    assert not backend.blank(frames[0])
    assert backend.blank(bytes(224 * 224 * 3)) and backend.blank(b"\x80" * (224 * 224 * 3))


def test_search_without_a_confident_frame_does_not_skip(backend):
    # The model never sure the action started (e.g. it runs from the first
    # frame, at an angle it is unsure of): stay at the start, not near the end.
    config = {"previewSegments": 12}
    for score in (0.6, 0.3):
        start, seen = backend.search(lambda times, s=score: [s] * len(times), 1800, config)
        assert start == 0 and seen
    config = {"previewSegments": 12, "previewExcludeStart": "30"}
    assert backend.search(lambda times: [0.5] * len(times), 1800, config)[0] == 30
    # A sure start is still found as before.
    hit = backend.search(lambda times: [0.9 if t >= 600 else 0.1 for t in times], 1800, config)[0]
    assert hit == pytest.approx(600, abs=10)


def test_search_helpers(backend):
    rule = backend.RULE
    assert backend.parse_exclude("5%", 200) == 10 and backend.parse_exclude("12", 200) == 12
    assert backend.parse_exclude(None, 200) == 0 and backend.parse_exclude("x", 200) == 0
    times = backend.coarse_times(1200, {"previewSegments": 12}, stash_segments(backend))
    assert len(times) == 12 and times[1] == 100
    # A long scene gets a coarse frame at least every 90 s.
    assert len(backend.coarse_times(1200, {"previewSegments": 12})) == 14
    assert backend.coarse_times(
        1200,
        {"previewSegments": 12, "previewExcludeStart": "10%"},
        stash_segments(backend),
    )[:2] == [
        120,
        210,
    ]
    assert backend.change_point([0.1, 0.1, 0.9, 0.95]) == 2
    assert backend.change_point([0.9, 0.9, 0.9]) == 0
    assert backend.change_point([0.1, 0.2, 0.1]) == 2
    assert backend.scan_window([0, 100, 200, 300], [0.1, 0.6, 0.7, 0.9], rule) == (
        0,
        300,
    )
    window = backend.scan_window([0, 100, 200, 300, 400], [0.1, 0.2, 0.95, 0.95, 0.95], rule)
    assert window == (100, 200)
    # A "maybe" frame before the jump moves the scan one sample back: the
    # start can lie before a frame the model was unsure about.
    window = backend.scan_window([0, 100, 200, 300, 400], [0.02, 0.04, 0.44, 0.99, 1.0], rule)
    assert window == (100, 300)
    # The jump at the very first frame scored (here 0:00 came out blank):
    # the start may lie before it, so the scan begins where sampling began.
    window = backend.scan_window([116, 232, 348], [0.98, 0.04, 0.92], rule, origin=0)
    assert window == (0, 116)
    assert backend.scan_times(0, 300, rule) == [
        0,
        37.5,
        75,
        112.5,
        150,
        187.5,
        225,
        262.5,
        300,
    ]
    assert backend.scan_times(100, 130, rule) == [100, 115, 130]
    assert backend.scan_times(200, 200, rule) == [200]
    assert backend.bisect_times(268, 289, 2) == [273.25, 278.5, 283.75]
    assert backend.bisect_times(100, 105, 3) == []


def test_search_finds_the_start_and_stops_early(backend):
    calls = []

    def score_at(times):
        calls.append(list(times))
        return [0.97 if t >= 437 else 0.05 for t in times]

    start, scores = backend.search(score_at, 1200, {"previewSegments": 12}, stash_segments(backend))
    # Coarse frames every 100 s, cut three at a time; the first two sure ones
    # (500, 600) end that pass, so nothing after the batch holding 600 is cut.
    assert calls[:3] == [[0, 100, 200], [300, 400, 500], [600, 700, 800]]
    # Scan 400..500, then bisection narrows the gap to within a few seconds.
    assert 437 <= start <= 437 + 15 / 8 + 1e-6
    assert all(400 <= t <= 500 for batch in calls[3:] for t in batch)
    # Cut but not needed: 700 and 800, and 460 and 475 after the first hit at 445.
    assert len(scores) == sum(len(batch) for batch in calls) - 4


def test_eager_search_asks_for_each_pass_at_once_with_the_same_answer(backend):
    def scorer(calls):
        def score_at(times):
            calls.append(list(times))
            return [0.97 if t >= 437 else 0.05 for t in times]

        return score_at

    lazy, eager = [], []
    rule = stash_segments(backend)
    expected = backend.search(scorer(lazy), 1200, {"previewSegments": 12}, rule)
    assert (
        backend.search(scorer(eager), 1200, {"previewSegments": 12}, rule, eager=True) == expected
    )
    assert len(eager[0]) == 12 and len(eager) == 3  # coarse, scan, bisection points
    assert len(lazy) > len(eager)


def test_search_reports_its_passes_in_order(backend):
    phases = []
    backend.search(
        lambda times: [0.97 if t >= 437 else 0.05 for t in times],
        1200,
        {"previewSegments": 12},
        on_phase=phases.append,
    )
    assert phases == ["sampling", "zooming", "pinpointing"]


def test_progress_reports_the_first_download(backend, monkeypatch):
    monkeypatch.setattr(
        backend,
        "status",
        lambda: {
            "ready": False,
            "supported": True,
            "downloading": True,
            "received": 5,
            "total": 10,
            "error": None,
        },
    )
    assert backend.scan_progress({"scene_id": 7}) == {
        "phase": "downloading",
        "received": 5,
        "total": 10,
        "error": None,
    }


def test_search_gives_up_on_blank_frames(backend):
    with pytest.raises(ValueError, match="blank"):
        backend.search(lambda times: [None] * len(times), 1200, {})


def test_platform_choice(backend, monkeypatch):
    monkeypatch.setattr(backend.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(backend.sys, "platform", "linux")
    monkeypatch.setattr(backend.glob, "glob", lambda pattern: ["/lib/ld-musl-x86_64.so.1"])
    assert backend.platform_key() == "linux-x64-musl"
    monkeypatch.setattr(backend.glob, "glob", lambda pattern: [])
    monkeypatch.setattr(backend.platform, "libc_ver", lambda: ("glibc", "2.39"))
    assert backend.platform_key() == "linux-x64-glibc"
    monkeypatch.setattr(backend.sys, "platform", "win32")
    monkeypatch.setattr(backend.platform, "machine", lambda: "AMD64")
    assert backend.platform_key() == "windows-x64"
    monkeypatch.setattr(backend.sys, "platform", "darwin")
    monkeypatch.setattr(backend.platform, "machine", lambda: "x86_64")
    assert backend.platform_key() is None  # Intel Macs have no build
    monkeypatch.setattr(backend.sys, "platform", "win32")
    monkeypatch.setattr(backend.platform, "machine", lambda: "ARM64")
    assert backend.platform_key() == "windows-arm64"
    monkeypatch.setattr(backend.sys, "platform", "linux")
    monkeypatch.setattr(backend.platform, "machine", lambda: "armv7l")
    assert backend.platform_key() is None  # 32-bit ARM: only Alpine has a build
    monkeypatch.setattr(backend.glob, "glob", lambda pattern: ["/lib/ld-musl-armhf.so.1"])
    assert backend.platform_key() == "linux-armv7-musl"
    assert all(key in backend.RUNTIMES for key in ("linux-arm64-musl", "macos-arm64"))


def test_unsupported_server_never_downloads(backend, monkeypatch):
    monkeypatch.setattr(backend, "platform_key", lambda: None)
    started = []
    monkeypatch.setattr(backend.subprocess, "Popen", lambda *a, **k: started.append(a))
    status = backend.ensure()
    assert not status["supported"] and not status["ready"] and not started


@pytest.mark.parametrize("kind", ["tgz", "zip"])
def test_runtime_archives_keep_only_the_named_members(backend, server, kind, tmp_path):
    import tarfile
    import zipfile

    base, files, _ = server
    members = {
        "ort/lib/libonnxruntime.so.1.2.3": b"LIB",
        "ort/LICENSE": b"MIT",
        "ort/x.h": b"h",
    }
    archive = tmp_path / f"ort.{kind}"
    if kind == "zip":
        with zipfile.ZipFile(archive, "w") as bundle:
            for name, body in members.items():
                bundle.writestr(name, body)
    else:
        with tarfile.open(archive, "w:gz") as bundle:
            for name, body in members.items():
                info = tarfile.TarInfo(name)
                info.size = len(body)
                bundle.addfile(info, io.BytesIO(body))
    runtime = entry(base, files, f"ort.{kind}", archive.read_bytes())
    runtime |= {
        "path": "runtime/ort",
        "members": {
            "ort/lib/libonnxruntime.so.1.2.3": "libonnxruntime.so",
            "ort/LICENSE": "LICENSE",
        },
        "library": "libonnxruntime.so",
    }
    backend.FILES = (runtime,)
    backend.download()
    folder = Path(backend.FILES_DIR, "runtime", "ort")
    assert sorted(p.name for p in folder.iterdir()) == ["LICENSE", "libonnxruntime.so"]
    assert (folder / "libonnxruntime.so").read_bytes() == b"LIB"
    assert backend.status()["received"] == backend.status()["total"]
    assert not Path(backend.FILES_DIR, "downloads", f"ort.{kind}.part").exists()


def test_model_is_read_from_a_local_copy_once_made(backend, monkeypatch, tmp_path):
    body = b"model bytes"
    monkeypatch.setattr(backend.tempfile, "gettempdir", lambda: str(tmp_path / "tmp"))
    monkeypatch.setitem(backend.MODEL, "size", len(body))
    shared = Path(backend.target_of(backend.MODEL))
    shared.parent.mkdir(parents=True)
    shared.write_bytes(body)
    assert backend.model_bytes() == body
    shared.write_bytes(b"x" * len(body))  # the share is not read again
    assert backend.model_bytes() == body
    copies = list((tmp_path / "tmp" / "auto-seek").iterdir())
    assert [p.name for p in copies] == [backend.MODEL["sha256"][:16] + ".onnx"]


def test_missing_files_start_the_download_only_when_allowed(backend, monkeypatch):
    monkeypatch.setattr(backend, "platform_key", lambda: next(iter(backend.RUNTIMES)))
    started = []
    monkeypatch.setattr(backend, "ensure", lambda: started.append(1) or {})
    with pytest.raises(backend.FilesMissing, match="turned off"):
        backend.scorer(2, download=False)
    assert started == []  # "Don't download the model" is respected
    with pytest.raises(backend.FilesMissing, match="still downloading"):
        backend.scorer(2)
    assert started == [1]


def test_analyse_answers_from_the_cache(backend, monkeypatch):
    backend.put_point(
        {
            "scene_id": 7,
            "start": 300,
            "duration": 1800,
            "model": default_id(backend),
            "scores": [(300, 0.9)],
        }
    )
    backend.put_point({"scene_id": 8, "start": 300, "duration": 1800, "model": "older"})
    worked = []
    monkeypatch.setattr(
        backend,
        "analyse_scene",
        lambda scene_id, server, eager=False: worked.append(scene_id) or {},
    )
    assert backend.analyse({"scene_id": 7}, {})["start"] == 300
    backend.analyse({"scene_id": 8}, {})
    assert worked == ["8"]  # a result from an older model is worked out again
    # So is one saved before frame times were kept, once, for the player's chart.
    with backend.cache() as connection:
        connection.execute("UPDATE start_point SET scores = '[0.1, 0.9]' WHERE scene_id = '7'")
    backend.analyse({"scene_id": 7}, {})
    assert worked == ["8", "7"]


def test_library_task_skips_answered_scenes_and_records_failures(backend, monkeypatch):
    monkeypatch.setattr(backend, "settings_now", lambda server: {"disableTimeline": True})
    backend.put_point({"scene_id": 1, "start": 30, "duration": 900, "model": default_id(backend)})
    backend.mark_point({"scene_id": 2, "start": 40, "duration": 900})
    pages = {1: ["1", "2", "3"], 2: ["4"]}
    monkeypatch.setattr(
        backend,
        "stash_query",
        lambda server, query, variables: {
            "findScenes": {
                "count": 4,
                "scenes": [{"id": i} for i in pages.get(variables["page"], [])],
            }
        },
    )
    monkeypatch.setattr(backend, "lower_priority", lambda: None)
    seen = []

    def analyse_scene(scene_id, server):
        seen.append(scene_id)
        if scene_id == "4":
            raise ValueError("broken file")
        backend.put_point(
            {
                "scene_id": scene_id,
                "start": 1,
                "duration": 9,
                "model": default_id(backend),
            }
        )

    monkeypatch.setattr(backend, "analyse_scene", analyse_scene)
    assert backend.library_task({}, {}) == {"analysed": 1, "failed": 1, "skipped": 2}
    assert seen == ["3", "4"]
    # The next run neither retries the failure nor redoes the rest.
    seen.clear()
    assert backend.library_task({}, {})["skipped"] == 4 and not seen


def test_new_scenes_queue_for_one_worker(backend, monkeypatch):
    monkeypatch.setattr(
        backend,
        "stash_query",
        lambda *args: {"configuration": {"plugins": {"auto-seek": {}}}},
    )
    monkeypatch.setattr(backend, "status", lambda: {"ready": True})
    spawned = []

    class Child:
        def __init__(self, args, **options):
            spawned.append((args, options))
            self.stdin = io.BytesIO()
            self.stdin.close = lambda: spawned.append(("stdin", self.stdin.getvalue()))

    monkeypatch.setattr(backend.subprocess, "Popen", Child)
    server = {"Port": 9999, "SessionCookie": {"Name": "session", "Value": "secret"}}
    assert backend.hook({"hookContext": {"id": 5, "type": "Scene.Create.Post"}}, server)["queued"]
    args, options = spawned[0]
    assert args[-1] == "worker" and (
        options.get("start_new_session") or options.get("creationflags")
    )
    # The connection goes to the worker over stdin, not into a file.
    assert json.loads(spawned[1][1]) == server
    assert not any(
        "secret" in p.read_text(errors="ignore") for p in Path(backend.DATA_DIR).glob("*.json")
    )
    # A running worker (holding the lock) is left to pick the next one up.
    with open(backend.WORKER_LOCK_PATH, "a+b") as held:
        assert backend.try_lock(held)
        backend.hook({"hookContext": {"id": 6}}, server)
    assert len([s for s in spawned if s[0] != "stdin"]) == 1
    with backend.cache() as connection:
        assert [
            r[0] for r in connection.execute("SELECT scene_id FROM pending ORDER BY scene_id")
        ] == ["5", "6"]


def test_worker_drains_the_queue(backend, monkeypatch):
    monkeypatch.setattr(backend, "settings_now", lambda server: {"disableTimeline": True})
    with backend.cache() as connection:
        connection.executemany(
            "INSERT INTO pending (scene_id, added_at) VALUES (?, ?)",
            [("5", "a"), ("6", "b"), ("7", "c")],
        )
    backend.put_point({"scene_id": 6, "start": 1, "duration": 9, "model": default_id(backend)})
    seen = []

    def analyse_scene(scene_id, server):
        seen.append((scene_id, server))
        if scene_id == "7":
            raise ValueError("broken file")

    monkeypatch.setattr(backend, "analyse_scene", analyse_scene)
    monkeypatch.setattr(backend, "lower_priority", lambda: None)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"Port": 1})))
    backend.worker()
    assert seen == [("5", {"Port": 1}), ("7", {"Port": 1})]
    assert backend.done_ids(["7"], default_id(backend)) == {
        "7"
    }  # failed with this model: not retried
    with backend.cache() as connection:
        assert connection.execute("SELECT COUNT(*) FROM pending").fetchone()[0] == 0


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")
def test_frame_preview_is_a_small_jpeg_of_that_moment(backend, tmp_path, monkeypatch):
    import base64

    video = tmp_path / "scene.mp4"
    source = "testsrc=duration=4:size=640x360:rate=10"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", source, str(video)],
        check=True,
    )
    monkeypatch.setattr(
        backend,
        "stash_query",
        lambda *a: {
            "findScene": {"files": [{"path": str(video), "duration": 4}]},
            "configuration": {"general": {"ffmpegPath": shutil.which("ffmpeg")}},
        },
    )
    frame = backend.frame_preview({"scene_id": 7, "time": 1.5}, {})
    assert base64.b64decode(frame["jpeg"])[:2] == b"\xff\xd8"
    assert backend.frame_preview({"scene_id": 7, "time": 60}, {})["jpeg"] is None


def test_ffmpeg_runs_are_limited_across_processes(backend, monkeypatch):
    monkeypatch.setattr(backend, "FFMPEG_SLOTS", 2)
    running = 0
    peak = 0
    lock = threading.Lock()

    def hold():
        nonlocal running, peak
        with backend.ffmpeg_slot():
            with lock:
                running += 1
                peak = max(peak, running)
            time.sleep(0.2)
            with lock:
                running -= 1

    # Threads open the lock files separately, so they contend for them as
    # separate ffmpeg-running processes would.
    threads = [threading.Thread(target=hold) for _ in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert peak == 2


def test_start_stage_and_model_settings(backend):
    assert backend.stage_of({}) == "oral"
    assert backend.stage_of({"startStage": "Kissing or later"}) == "kissing"
    assert backend.stage_of({"startStage": "sex positions"}) == "sex"
    assert backend.stage_of({"startStage": "positions"}) == "sex"
    assert backend.stage_of({"startStage": "anything"}) == "anything"
    assert backend.stage_of({"startStage": "nonsense"}) == "oral"
    # The settings page's own pick of acts: unknown names drop out, and a
    # pick that equals a stage is that stage (its cached starts stand).
    picked = backend.stage_of({"startStage": "acts: Cowgirl, kissing, made up"})
    assert picked == "acts:1-14"
    assert backend.stage_acts(picked) == ("kissing", "cowgirl")
    positions = ", ".join(reversed(backend.POSITIONS))
    assert backend.stage_of({"startStage": f"acts: {positions}"}) == "sex"
    assert backend.stage_of({"startStage": "acts: nothing yet"}) == "oral"
    assert backend.model_id("fast", picked) != backend.model_id("fast", "acts:1")
    assert backend.size_of({"accurateModel": True}) == "accurate"
    # Every stage and size caches under its own id, so a change recomputes.
    ids = {backend.model_id(size, stage) for size in backend.MODELS for stage in backend.STAGES}
    assert len(ids) == len(backend.MODELS) * len(backend.STAGES)
    assert all(act in backend.ACTS for acts in backend.STAGES.values() for act in acts)
    acts = [0.0] * len(backend.ACTS)
    acts[backend.ACTS.index("kissing")] = 0.5
    acts[backend.ACTS.index("cowgirl")] = 0.5
    assert backend.stage_score(acts, "sex") == 0.5
    assert backend.stage_score(acts, "kissing") == 0.75
    assert backend.stage_score(acts, "acts:14") == 0.5
    # Choosing the other size switches the download to that model only.
    backend.choose("accurate")
    assert backend.chosen_size() == "accurate"
    assert backend.MODELS["accurate"] in backend.FILES
    assert backend.MODELS["fast"] not in backend.FILES


def test_analysis_scores_the_stage_and_a_frame_ten_seconds_on(backend, monkeypatch):
    # Kissing in a two-second teaser at 360 s (a coarse frame), then from 500 s; oral from 900 s.
    def acts_at(t):
        acts = [0.01] * len(backend.ACTS)
        if 360 <= t < 362 or t >= 500:
            acts[backend.ACTS.index("kissing")] = 0.99
        if t >= 900:
            acts[backend.ACTS.index("oral on him")] = 0.99
        return acts

    class Session:
        def score(self, pixels, features):
            return 0.5, acts_at(round(features[0] * 1800, 3))

    settings: dict = {}
    monkeypatch.setattr(
        backend,
        "stash_query",
        lambda *args: {
            "findScene": {"files": [{"path": "/v.mp4", "duration": 1800}]},
            "configuration": {
                "general": {"previewSegments": 12},
                "plugins": {"auto-seek": settings},
            },
        },
    )
    monkeypatch.setattr(backend, "scorer", lambda threads, download=True: Session())
    monkeypatch.setattr(backend, "find_ffmpeg", lambda configured, server: "ffmpeg")
    monkeypatch.setattr(
        backend,
        "grab_frames",
        lambda ffmpeg, path, times: [b"\0\xff" * 64] * len(times),
    )
    found = backend.analyse_scene("1", {})
    assert 890 <= found["start"] <= 905 and found["model"] == default_id(backend)
    settings["startStage"] = "kissing"
    found = backend.analyse_scene("1", {})
    # The teaser frame at 360 s is not followed by kissing 10 s later.
    assert 490 <= found["start"] <= 505 and found["model"] == backend.model_id("fast", "kissing")


def test_timeline_grid_runs_left_to_right(backend):
    assert backend.timeline_grid(1000, 10) == [10.0 * k for k in range(100)]


def fake_scene(backend, monkeypatch, acts_at, duration=1800, settings=None):
    """A scene the backend cuts and scores without ffmpeg or a model: the
    model's act scores come from acts_at(time)."""
    cut: list[float] = []

    class Session:
        def score(self, pixels, features):
            return 0.5, acts_at(round(features[0] * duration, 2))

        def score_embedding(self, pixels, features):
            t = round(features[0] * duration, 2)  # the embedding says when it was cut
            return 0.5, acts_at(t), [t] + [0.0] * 511

    settings = {} if settings is None else settings
    monkeypatch.setattr(
        backend,
        "stash_query",
        lambda *args: {
            "findScene": {"files": [{"path": "/v.mp4", "duration": duration}]},
            "configuration": {
                "general": {"previewSegments": 12},
                "plugins": {"auto-seek": settings},
            },
        },
    )
    monkeypatch.setattr(backend, "settings_now", lambda server: settings)
    monkeypatch.setattr(backend, "scorer", lambda threads, download=True: Session())
    monkeypatch.setattr(backend, "find_ffmpeg", lambda configured, server: "ffmpeg")

    def grab(ffmpeg, path, times):
        cut.extend(times)
        return [b"\0\xff" * 64] * len(times)

    monkeypatch.setattr(backend, "grab_frames", grab)
    return cut, settings


def test_timeline_finds_where_each_act_first_shows(backend, monkeypatch):
    # Kissing from 203 s (and a one-frame flash at 100 s); cowgirl from 905 s.
    def acts_at(t):
        acts = [0.01] * len(backend.ACTS)
        if t >= 203 or t == 100:
            acts[backend.ACTS.index("kissing")] = 0.95
        if t >= 905:
            acts[backend.ACTS.index("cowgirl")] = 0.95
        return acts

    cut, settings = fake_scene(backend, monkeypatch, acts_at)
    saves = []
    save = backend.save_timeline
    monkeypatch.setattr(
        backend, "save_timeline", lambda *a, **k: saves.append(a[5]) or save(*a, **k)
    )
    row = backend.scan_timeline("1", {})
    assert row["state"] == 1 and saves[-1] == 1 and saves.count(0) > 3  # saved as it went
    firsts = row["firsts"]
    assert 203 <= firsts["kissing"] <= 203 + 2.5  # not the flash at 100 s
    assert 905 <= firsts["cowgirl"] <= 905 + 2.5
    assert list(firsts) == ["kissing", "cowgirl"] and "oral on him" not in firsts
    assert len(cut) < 1800 / 10 + 20  # the grid, its last partner and a few to narrow down
    view = backend.timeline_view({"scene_id": "1"}, {})
    assert view["state"] == "done" and view["firsts"] == firsts
    assert len(view["acts"]) == len(backend.ACTS) and view["frames"][0][1][0] == 1  # percent
    # A finer spacing rescans, reusing the frames it has.
    cut.clear()
    settings["timelineSpacing"] = 5
    assert backend.scan_timeline("1", {})["model"].endswith("/x5+t80p10")
    assert 1800 / 10 - 20 < len(cut) < 1800 / 10 + 20  # only the new half of the grid


def test_timeline_head_scores_the_grid(backend, monkeypatch):
    # The model alone sees kissing from 100 s; the head (reading a frame with
    # the ones 10 s either side) only once their mean time is 300 s. The head
    # picks the grid step, the model's own scores narrow the start inside it.
    kiss = backend.ACTS.index("kissing")

    def acts_at(t):
        acts = [0.01] * len(backend.ACTS)
        acts[kiss] = 0.95 if t >= 100 else 0.01
        return acts

    class Head:
        def scores(self, rows):
            out = []
            for row in rows:
                acts = [0.01] * len(backend.ACTS)
                acts[kiss] = 0.95 if row[512] >= 300 else 0.01  # the mean's time
                out.append(acts)
            return out

    cut, settings = fake_scene(backend, monkeypatch, acts_at, settings={"accurateModel": True})
    monkeypatch.setattr(backend, "head_scorer", lambda: Head())
    backend.analyse_scene("1", {})  # the start search's frames must not seed the grid
    cut.clear()
    row = backend.scan_timeline("1", {})
    assert "+nb/x10" in row["model"]
    assert 290 < row["firsts"]["kissing"] <= 300
    shown = dict((t, a) for t, a in row["frames"])
    assert shown[200][kiss] == 1 and shown[300][kiss] == 95  # the head's, in percent
    assert len(cut) < 1800 / 10 + 20  # the head reads the grid: no extra frames
    # A paused scan resumes with the head's saved frames and finds the same.
    whole = row["firsts"]
    backend.save_timeline("1", row["model"], 1800, {}, {}, 0)
    calls = iter([False] * 10 + [True] + [False] * 1000)
    monkeypatch.setattr(backend, "page_waiting", lambda scene_id: next(calls))
    with pytest.raises(backend.Paused):
        backend.scan_timeline("1", {}, yields=True)
    cut.clear()
    assert backend.scan_timeline("1", {})["firsts"] == whole
    assert len(cut) < 1800 / 10 - 40 + 10  # the rest, and the frames either side again
    # A spacing that doesn't divide 10 s: the model's own scores.
    settings["timelineSpacing"] = 15
    row = backend.scan_timeline("1", {})
    assert "+nb" not in row["model"] and row["firsts"]["kissing"] <= 100


def test_dropped_acts_neither_count_nor_show(backend, monkeypatch):
    # Rimming everywhere: no stage counts it, the timeline finds no start for
    # it, and the view hides it, also from a timeline saved before the drop.
    def acts_at(t):
        acts = [0.01] * len(backend.ACTS)
        acts[backend.ACTS.index("rimming")] = 0.95
        return acts

    assert all("rimming" not in acts for acts in backend.STAGES.values())
    assert backend.stage_of({"startStage": "acts: rimming"}) == "oral"
    assert backend.stage_score(acts_at(0), "anything") < 0.5
    fake_scene(backend, monkeypatch, acts_at)
    row = backend.scan_timeline("1", {})
    assert "rimming" not in row["firsts"]
    j = backend.ACTS.index("rimming")
    old = dict(row, firsts={"rimming": 0.0})
    monkeypatch.setattr(backend, "load_timeline", lambda scene_id: old)
    view = backend.timeline_view({"scene_id": "1"}, {})
    assert view["state"] == "done" and view["firsts"] == {}
    assert all(a[j] == 0 for _, a in view["frames"] if a is not None)


def test_timeline_view_queues_an_unscanned_scene_first(backend, monkeypatch):
    fake_scene(backend, monkeypatch, lambda t: [0.0] * len(backend.ACTS))
    started = []
    monkeypatch.setattr(backend, "start_worker", lambda server: started.append(server))
    backend.queue_scene("9", {}, priority=0)
    assert backend.timeline_view({"scene_id": "5"}, {"Port": 1})["state"] == "queued"
    with backend.cache() as connection:
        order = connection.execute(
            "SELECT scene_id FROM pending ORDER BY priority DESC, added_at"
        ).fetchall()
    assert [r[0] for r in order] == ["5", "9"] and started[-1] == {"Port": 1}
    monkeypatch.setattr(backend, "settings_now", lambda server: {"disableTimeline": True})
    assert backend.timeline_view({"scene_id": "5"}, {}) == {"state": "off"}


def test_the_worker_finds_the_start_then_the_timeline(backend, monkeypatch):
    fake_scene(backend, monkeypatch, lambda t: [0.0] * len(backend.ACTS))
    done = []
    monkeypatch.setattr(
        backend, "analyse_scene", lambda scene_id, server: done.append(("start", scene_id))
    )
    monkeypatch.setattr(
        backend,
        "scan_timeline",
        lambda scene_id, server, yields=False: done.append(("timeline", scene_id)),
    )
    monkeypatch.setattr(backend, "lower_priority", lambda: None)
    monkeypatch.setattr(sys, "stdin", io.StringIO("{}"))
    with backend.cache() as connection:
        connection.execute("INSERT INTO pending (scene_id, added_at) VALUES ('4', 'a')")
    backend.worker()
    assert done == [("start", "4"), ("timeline", "4")]


def test_frames_from_the_start_search_dont_pass_for_a_scan(backend, monkeypatch):
    fake_scene(backend, monkeypatch, lambda t: [0.0] * len(backend.ACTS))
    started = []
    monkeypatch.setattr(backend, "start_worker", lambda server: started.append(1))
    backend.analyse_scene("3", {})  # saves its frames to the timeline, waiting
    assert backend.load_timeline("3")["state"] == 3
    assert backend.timeline_view({"scene_id": "3"}, {})["state"] == "queued" and started


def test_a_page_request_pauses_a_background_scan(backend, monkeypatch):
    cut, _ = fake_scene(backend, monkeypatch, lambda t: [0.0] * len(backend.ACTS))
    monkeypatch.setattr(backend, "lower_priority", lambda: None)
    monkeypatch.setattr(backend, "done_ids", lambda ids, model: set(ids))  # starts known
    monkeypatch.setattr(backend, "start_worker", lambda server: None)
    order, asked = [], []
    scan, save = backend.scan_timeline, backend.save_timeline

    def tracked(scene_id, server, yields=False):
        order.append(scene_id)
        return scan(scene_id, server, yields)

    def saving(*args, **kwargs):
        save(*args, **kwargs)
        if args[0] == "1" and args[5] == 0 and not asked:
            asked.append(1)  # a page opens scene 2 while scene 1 scans in the background
            backend.queue_scene("2", {}, priority=2_000_000_000)

    monkeypatch.setattr(backend, "scan_timeline", tracked)
    monkeypatch.setattr(backend, "save_timeline", saving)
    with backend.cache() as connection:
        connection.execute("INSERT INTO pending (scene_id, added_at) VALUES ('1', 'a')")
    monkeypatch.setattr(sys, "stdin", io.StringIO("{}"))
    backend.worker()
    assert order == ["1", "2", "1"]  # paused for scene 2, then resumed
    assert backend.load_timeline("1")["state"] == 1 and backend.load_timeline("2")["state"] == 1
    # Each scene's frames cut once: the resumed scan kept the frames it had.
    assert len(cut) == 2 * len(set(cut))
