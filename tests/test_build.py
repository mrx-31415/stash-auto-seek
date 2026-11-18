import importlib.util
import subprocess
import zipfile
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build", ROOT / "scripts" / "build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def test_archive_and_index_agree(tmp_path: Path) -> None:
    entry = build.build(tmp_path, "9.8.7+dev.1.abc", "2026-01-02 03:04:05")
    archive = tmp_path / f"{build.PLUGIN_ID}.zip"
    with zipfile.ZipFile(archive) as package:
        assert set(package.namelist()) == {*build.FILES, "LICENSE"}
        manifest = package.read(build.MANIFEST.name).decode()
    assert "version: 9.8.7+dev.1.abc\n" in manifest
    assert entry.startswith(f"- id: {build.PLUGIN_ID}\n")
    assert f"  sha256: {sha256(archive.read_bytes()).hexdigest()}\n" in entry
    assert "  date: 2026-01-02 03:04:05\n" in entry
    assert (tmp_path / f"{build.PLUGIN_ID}-index.yml").read_text() == entry


def test_dev_version_counts_commits_since_the_release_tag(tmp_path: Path, monkeypatch) -> None:
    def git(*args: str) -> None:
        subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)

    plugin = tmp_path / build.PLUGIN_ID
    plugin.mkdir()
    manifest = plugin / build.MANIFEST.name
    manifest.write_text("version: 1.2.3 # x-release-please-version\n")
    git("init", "-q")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init", "--allow-empty")
    git("add", ".")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "release")
    git("tag", f"{build.PLUGIN_ID}-v1.2.3")
    monkeypatch.setattr(build, "ROOT", tmp_path)
    monkeypatch.setattr(build, "MANIFEST", manifest)
    assert build.dev_version() == "1.2.3"
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "next", "--allow-empty")
    assert build.dev_version().startswith("1.2.3+dev.1.")


def test_the_development_plugin_is_never_packaged(tmp_path: Path) -> None:
    """auto-seek-dev/ (review tools) lives in this repository but ships nowhere:
    not in a release's archive nor in the dev source built from main."""
    for plugin_version in ("9.8.7", "9.8.7+dev.1.abc"):
        build.build(tmp_path / plugin_version, plugin_version, "2026-01-02 03:04:05")
        with zipfile.ZipFile(tmp_path / plugin_version / f"{build.PLUGIN_ID}.zip") as package:
            names = package.namelist()
        assert not [name for name in names if "auto_seek_dev" in name or "auto-seek-dev" in name]
    assert (ROOT / "auto-seek-dev" / "auto-seek-dev.yml").is_file()
