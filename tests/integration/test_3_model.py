"""The real path: download the model and runtime, analyse the clip on the
server, and show the result on the player. The first run downloads about
100 MB; CI keeps the files between runs (AUTO_SEEK_FILES)."""

from __future__ import annotations

import time

import pytest
from conftest import wait_for_job
from playwright.sync_api import expect
from test_2_player import open_scene

pytestmark = pytest.mark.model

MODEL_ID = "clip3-v2+t70"


@pytest.fixture(scope="module")
def ready(gql):
    def status():
        return gql('mutation { runPluginOperation(plugin_id: "auto-seek", args: {op: "ensure"}) }')[
            "runPluginOperation"
        ]

    deadline = time.monotonic() + 600
    current = status()
    while not current["ready"]:
        assert current["downloading"] or not current["error"], current
        assert time.monotonic() < deadline, f"download unfinished after 10 minutes: {current}"
        time.sleep(2)
        current = status()


def test_the_server_finds_a_start_and_caches_it(ready, operation, scene) -> None:
    result = operation(op="analyse", scene_id=scene["id"], force=True)
    assert result["model"] == MODEL_ID
    assert result["duration"] == pytest.approx(scene["duration"])
    assert result["frames"] > 0 and result["samples"]
    assert 0 <= result["start"] <= scene["duration"]
    assert all(0 <= score <= 1 for _, score in result["samples"])
    cached = operation(op="get", scene_ids=[scene["id"]])[scene["id"]]
    assert cached["model"] == MODEL_ID and cached["start"] == result["start"]


def test_the_player_offers_the_found_start(ready, page, base_url, scene, operation, errors) -> None:
    start = operation(op="analyse", scene_id=scene["id"])["start"]
    open_scene(page, base_url, scene)
    target = round(max(0, start - 3))  # the player rounds to whole seconds
    label = f"Skip intro (to {target // 60}:{target % 60:02d})"
    expect(page.locator(".auto-seek-button")).to_have_attribute("title", label, timeout=30_000)
    expect(page.locator(".auto-seek-strip-label")).to_contain_text("Starts at")
    assert errors == []


def test_the_library_task_finishes(ready, gql, operation, scene) -> None:
    job = gql('mutation { runPluginTask(plugin_id: "auto-seek", task_name: "Find start points") }')[
        "runPluginTask"
    ]
    wait_for_job(gql, job, timeout=300)
    assert operation(op="get", scene_ids=[scene["id"]])[scene["id"]]["model"] == MODEL_ID
