"""The development plugin (auto-seek-dev/): review marks and the review queue,
on Auto Seek's own cache, with both plugins installed side by side."""

import importlib.util
import json
import sys
from pathlib import Path

import pytest
from test_auto_seek_backend import fake_scene

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def plugins(tmp_path, monkeypatch):
    """Stash's plugin folder with Auto Seek and Auto Seek (dev) side by side;
    returns (dev module, the Auto Seek module it works on)."""
    main_dir = tmp_path / "plugins" / "auto-seek"
    dev_dir = tmp_path / "plugins" / "auto-seek-dev"
    main_dir.mkdir(parents=True)
    dev_dir.mkdir()
    for name in ("auto_seek.py", "ort_api.py"):
        (main_dir / name).symlink_to(ROOT / "auto-seek" / name)
    monkeypatch.setattr(sys, "argv", ["auto_seek_dev.py", str(dev_dir)])
    monkeypatch.delitem(sys.modules, "auto_seek", raising=False)
    monkeypatch.setattr(sys, "path", list(sys.path))
    spec = importlib.util.spec_from_file_location(
        "auto_seek_dev", ROOT / "auto-seek-dev" / "auto_seek_dev.py"
    )
    dev = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dev)
    main = dev.load_auto_seek()
    yield dev, main
    sys.modules.pop("auto_seek", None)


def test_marks_go_into_auto_seeks_cache(plugins, monkeypatch):
    dev, main = plugins
    # Auto Seek's paths stay on its own folder, not the dev plugin's.
    assert Path(main.CACHE_PATH).parent.parent.name == "auto-seek"
    fake_scene(main, monkeypatch, lambda t: [0.3] * len(main.ACTS))
    main.scan_timeline("1", {})
    dev.review_act(main, {"scene_id": "1", "t": 20, "act": "facial", "verdict": 0})
    dev.review_act(main, {"scene_id": "1", "t": 20, "act": "oral on him", "verdict": 1})
    reviews = dev.review_act(main, {"scene_id": "1", "t": 20, "act": "facial", "verdict": 1})[
        "reviews"
    ]
    assert sorted(reviews) == [[20.0, "facial", 1], [20.0, "oral on him", 1]]
    with main.cache() as connection:
        model, score = connection.execute(
            "SELECT model, score FROM act_review WHERE act = 'facial'"
        ).fetchone()
    assert model.startswith("acts-") and score == 0.3  # what the model said when marked
    # Marked at the playhead, between scanned frames: the nearest frame's score.
    dev.review_act(main, {"scene_id": "1", "t": 23.4, "act": "kissing", "verdict": 0})
    with main.cache() as connection:
        assert (
            connection.execute("SELECT score FROM act_review WHERE act = 'kissing'").fetchone()[0]
            == 0.3
        )
    dev.review_act(main, {"scene_id": "1", "t": 23.4, "act": "kissing", "verdict": None})
    dev.review_act(main, {"scene_id": "1", "t": 20, "act": "facial", "verdict": None})
    assert dev.reviews_of(main, "1") == [[20.0, "oral on him", 1]]
    with pytest.raises(ValueError):
        dev.review_act(main, {"scene_id": "1", "t": 20, "act": "nothing yet", "verdict": 1})
    # Auto Seek itself no longer serves review marks.
    assert "review" not in main.OPERATIONS
    assert "reviews" not in main.timeline_view({"scene_id": "1", "queue": False}, {})


def test_the_queue_settles_spots_that_have_a_mark_nearby(plugins):
    dev, main = plugins
    assert dev.review_queue(main)["scenes"] == []  # no queue file yet
    Path(dev.QUEUE_PATH).parent.mkdir(parents=True)
    spots = [
        {"t": 100, "act": "cowgirl", "yours": 0.1, "teacher": 0.9},
        {"t": 400, "act": "facial", "yours": 0.85, "teacher": 0.05},
    ]
    Path(dev.QUEUE_PATH).write_text(
        json.dumps(
            {"models": {"yours": "a", "teacher": "b"}, "scenes": [{"id": 7, "spots": spots}]}
        )
    )
    dev.review_act(main, {"scene_id": "7", "t": 108, "act": "cowgirl", "verdict": 1})  # within 15 s
    dev.review_act(main, {"scene_id": "7", "t": 400, "act": "kissing", "verdict": 0})  # another act
    (scene,) = dev.review_queue(main)["scenes"]
    assert scene["id"] == "7" and scene["left"] == 1
    assert [spot["done"] for spot in scene["spots"]] == [True, False]


def test_the_dev_plugin_says_when_auto_seek_is_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["auto_seek_dev.py", str(tmp_path / "auto-seek-dev")])
    spec = importlib.util.spec_from_file_location(
        "auto_seek_dev", ROOT / "auto-seek-dev" / "auto_seek_dev.py"
    )
    dev = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dev)
    with pytest.raises(RuntimeError, match="isn't installed next to this plugin"):
        dev.load_auto_seek()


def test_prefetch_queues_the_next_unscanned_scenes_in_the_background(plugins, monkeypatch):
    dev, main = plugins
    Path(dev.QUEUE_PATH).parent.mkdir(parents=True)
    spot = {"t": 100, "act": "cowgirl", "yours": 0.1, "teacher": 0.9}
    scenes = [{"id": n, "spots": [spot]} for n in (1, 2, 3, 4, 5)]
    Path(dev.QUEUE_PATH).write_text(json.dumps({"scenes": scenes}))
    dev.review_act(main, {"scene_id": "3", "t": 100, "act": "cowgirl", "verdict": 1})  # 3 is done
    scanned = {"4": {"state": 1}}  # 4's timeline is ready
    monkeypatch.setattr(main, "load_timeline", lambda scene_id: scanned.get(scene_id))
    queued = []
    monkeypatch.setattr(
        main, "queue_scene", lambda scene_id, server, priority: queued.append((scene_id, priority))
    )
    reply = dev.prefetch(main, {"after": "2", "count": 2}, {})
    # After scene 2, skipping the reviewed 3 and the scanned 4, then round to 1.
    assert reply == {"queued": ["5", "1"]}
    assert queued == [("5", dev.PREFETCH_PRIORITY), ("1", dev.PREFETCH_PRIORITY)]
