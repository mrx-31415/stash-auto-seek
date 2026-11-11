"""Stash loads the packaged plugin: its task, hook, settings and backend."""

from __future__ import annotations

from conftest import PLUGIN_ID


def test_stash_lists_the_plugin_with_its_task_hook_and_settings(gql) -> None:
    plugins = gql(
        "{ plugins { id version enabled tasks { name } hooks { hooks } settings { name } } }"
    )
    plugin = next(p for p in plugins["plugins"] if p["id"] == PLUGIN_ID)
    assert plugin["enabled"]
    assert [task["name"] for task in plugin["tasks"]] == ["Find start points"]
    assert plugin["hooks"] == [{"hooks": ["Scene.Create.Post"]}]
    assert {s["name"] for s in plugin["settings"]} == {
        "autoSkip", "leadIn", "hideScanChart", "disableNewScenes", "threads", "disableDownload"
    }  # fmt: skip


def test_the_backend_runs_on_stashs_python(operation) -> None:
    status = operation(op="status")
    # Stash's Docker image is Alpine: the musl runtime build.
    assert status["supported"], status
    assert status["platform"].startswith("linux-") and status["platform"].endswith("-musl")
    model, runtime = sorted(status["files"])
    assert model == "models/auto-seek-clip3-v2.onnx"
    assert runtime.startswith("runtime/ort-alpine-")
