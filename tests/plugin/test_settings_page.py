"""The settings page (auto-seek.js) and the backend (auto_seek.py) agree on
the acts, the stages and how the Start at setting reads."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = [
    "", "oral", "Kissing or later", "sex positions", "anything", "foreplay", "nonsense",
    "acts: cowgirl, kissing", "acts: Missionary, made up", "acts: nothing yet",
    "acts: " + "cowgirl, missionary, doggy style, prone bone, side/spoon, ballerina, "
    "stand & carry, pile driving, scissoring",
]  # fmt: skip


@pytest.fixture
def backend(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["auto_seek.py", str(tmp_path)])
    spec = importlib.util.spec_from_file_location("auto_seek_page", ROOT / "auto-seek/auto_seek.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def page():
    run = subprocess.run(
        ["node", str(Path(__file__).with_name("settings_page.cjs")), json.dumps(SAMPLES)],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(run.stdout)


def test_the_page_lists_every_act_once(backend, page):
    listed = [act for group in page["groups"] for act in group["acts"]]
    shown = [act for act in backend.ACTS[1:] if act not in backend.DROPPED]
    assert sorted(listed) == sorted(shown)  # all but "nothing yet" and the dropped
    assert len(listed) == len(set(listed))


def test_the_presets_are_the_backend_stages(backend, page):
    assert {key: set(acts) for key, acts in page["presets"].items()} == {
        key: set(acts) for key, acts in backend.STAGES.items()
    }


def test_the_page_reads_and_writes_the_setting_as_the_backend_does(backend, page):
    for value, read, written in zip(SAMPLES, page["read"], page["written"], strict=True):
        stage = backend.stage_of({"startStage": value})
        assert set(read["acts"]) == set(backend.stage_acts(stage)), value
        assert (read["preset"] is None) == stage.startswith("acts:"), value
        # What the page saves reads back as the same stage.
        assert backend.stage_of({"startStage": written}) == stage, value
