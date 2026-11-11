#!/usr/bin/env python3
"""Package the plugin and write its Stash plugin-source index.

    scripts/build.py          dist/<id>.zip and dist/<id>-index.yml (a release's assets)
    scripts/build.py --dev    the same in dist/dev/, plus dist/dev/index.yml, with a
                              version tagged by the commits since the last release

The release attaches dist/<id>.zip and dist/<id>-index.yml; the dev plugin
source on GitHub Pages serves dist/dev/.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import zipfile
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PLUGIN_ID = "auto-seek"
PLUGIN_NAME = "Auto Seek"
# Python and JavaScript only: it downloads its model and ONNX Runtime on first use.
FILES = ("auto_seek.py", "ort_api.py", "auto-seek.js", "auto-seek.css", "auto-seek.yml")
DESCRIPTION = (
    "Skip the intro of every scene: finds where the action starts, on your server, "
    "and jumps straight there."
)

PLUGIN_DIR = ROOT / PLUGIN_ID
MANIFEST = PLUGIN_DIR / f"{PLUGIN_ID}.yml"


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout.strip()


def version() -> str:
    """The released version, from the manifest line release-please bumps."""
    match = re.search(r"(?m)^version: (\S+)", MANIFEST.read_text("utf-8"))
    if match is None:
        raise RuntimeError(f"{MANIFEST.name} has no version")
    return match.group(1)


def dev_version() -> str:
    """The release version tagged with the commits merged since that release.

    The dev source rebuilds on every push to main, so the suffix tells which
    commit an installation runs; the release commit keeps the plain version.
    """
    base = version()
    tag = f"{PLUGIN_ID}-v{base}"
    try:
        count = git("rev-list", "--count", f"{tag}..HEAD")
    except subprocess.CalledProcessError:  # tag not fetched: count from the start
        count = git("rev-list", "--count", "HEAD")
    if count == "0":
        return base
    return f"{base}+dev.{count}.{git('rev-parse', '--short', 'HEAD')}"


def build(directory: Path, plugin_version: str, build_date: str | None = None) -> str:
    """Write <id>.zip and <id>-index.yml into directory; returns the index entry."""
    build_date = build_date or datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")
    directory.mkdir(parents=True, exist_ok=True)
    archive_path = directory / f"{PLUGIN_ID}.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            data = (PLUGIN_DIR / name).read_bytes()
            if name == MANIFEST.name:
                # Keep the manifest's version in lockstep with the index.
                data = re.sub(
                    rb"(?m)^version: .*$", f"version: {plugin_version}".encode(), data, count=1
                )
            archive.writestr(name, data)
        archive.write(ROOT / "LICENSE", "LICENSE")
    entry = "\n".join(
        (
            f"- id: {PLUGIN_ID}",
            f"  name: {PLUGIN_NAME}",
            f"  version: {plugin_version}",
            f"  date: {build_date}",
            f"  path: {archive_path.name}",
            f"  sha256: {sha256(archive_path.read_bytes()).hexdigest()}",
            "  metadata:",
            # Quoted: the text has a colon, which plain YAML reads as a key.
            f"    description: {json.dumps(DESCRIPTION, ensure_ascii=False)}",
            "",
        )
    )
    (directory / f"{PLUGIN_ID}-index.yml").write_text(entry, encoding="utf-8")
    return entry


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dev", action="store_true", help="build the dev source into dist/dev/")
    args = parser.parse_args()
    if args.dev:
        out = ROOT / "dist" / "dev"
        (out / "index.yml").write_text(build(out, dev_version()), encoding="utf-8")
    else:
        out = ROOT / "dist"
        build(out, version())
    print(out / f"{PLUGIN_ID}.zip")
