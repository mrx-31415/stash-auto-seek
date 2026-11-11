"""Auto Seek's controls on Stash's own player, driven through a marked start,
which the backend answers from its cache without the model."""

from __future__ import annotations

import pytest
from conftest import dismiss_modals
from playwright.sync_api import Page, expect


@pytest.fixture
def marked(operation, scene):
    """The scene's start marked at 0:20, as the player's flag would."""
    operation(op="mark", scene_id=scene["id"], start=20, duration=scene["duration"])
    yield scene
    operation(op="unmark", scene_id=scene["id"])


def open_scene(page: Page, base_url: str, scene) -> None:
    page.goto(f"{base_url}/scenes/{scene['id']}", wait_until="domcontentloaded")
    dismiss_modals(page)
    expect(page.locator(".video-js video")).to_have_count(1, timeout=30_000)


def current_time(page: Page) -> float:
    return page.locator(".video-js video").evaluate("video => video.currentTime")


def test_controls_join_the_player_and_keep_its_own(page, base_url, marked, errors) -> None:
    open_scene(page, base_url, marked)
    button = page.locator(".auto-seek-button")
    # Lead-in 3 s by default: the jump lands just before the start.
    expect(button).to_have_attribute("title", "Skip intro (to 0:17, your mark)")
    expect(button).to_have_attribute("data-state", "ready")
    expect(page.locator(".auto-seek-mark")).to_have_count(1)
    expect(page.locator(".auto-seek-pill")).to_be_visible()
    for native in (".vjs-play-control", ".vjs-fullscreen-control", ".vjs-progress-control"):
        expect(page.locator(native)).to_have_count(1)
    assert errors == []


def test_skip_intro_jumps_to_the_start(page, base_url, marked, errors) -> None:
    open_scene(page, base_url, marked)
    page.locator(".video-js video").evaluate("video => { video.muted = true; }")
    pill = page.locator(".auto-seek-pill")
    expect(pill.locator(".auto-seek-pill-arrow")).to_be_visible()
    pill.click()
    expect(page.locator(".auto-seek-toast").first).to_contain_text("Skipped to 0:17")
    assert 17 <= current_time(page) < 25
    expect(pill).to_be_hidden()  # no intro left to skip
    assert errors == []


def test_lead_in_setting_moves_the_jump(page, base_url, marked, configure, errors) -> None:
    configure(leadIn=0)
    open_scene(page, base_url, marked)
    expect(page.locator(".auto-seek-button")).to_have_attribute(
        "title", "Skip intro (to 0:20, your mark)"
    )
    assert errors == []


def test_the_flag_marks_the_start_for_good(page, base_url, scene, operation, errors) -> None:
    try:
        open_scene(page, base_url, scene)
        page.locator(".video-js video").evaluate(
            "video => { video.muted = true; video.currentTime = 12; }"
        )
        page.wait_for_function("() => document.querySelector('.video-js video').currentTime >= 12")
        page.locator(".auto-seek-mark").dispatch_event("click")
        expect(page.locator(".auto-seek-toast").first).to_contain_text("Start set to 0:12")
        page.wait_for_timeout(1000)  # the save follows the toast
        saved = operation(op="get", scene_ids=[scene["id"]])[scene["id"]]
        assert saved["model"] == "user" and saved["start"] == pytest.approx(12, abs=0.5)
        # A reload offers the marked start.
        open_scene(page, base_url, scene)
        expect(page.locator(".auto-seek-button")).to_have_attribute(
            "title", "Skip intro (to 0:09, your mark)"
        )
    finally:
        operation(op="unmark", scene_id=scene["id"])
    assert errors == []


@pytest.mark.xfail(
    strict=True,
    reason="disableDownload is not respected: analyse calls ensure() when the files are "
    "missing (scorer() in auto_seek.py), so opening a scene starts the download",
)
def test_without_the_model_the_player_still_works(
    page, base_url, scene, operation, configure, hide_data, errors
) -> None:
    # Downloads turned off and nothing downloaded or cached yet.
    configure(disableDownload=True)
    hide_data("files", "verified.json", "cache.sqlite3")
    requested: list[str] = []
    page.on(
        "request",
        lambda r: (
            requested.append(
                ((r.post_data_json or {}).get("variables") or {}).get("args", {}).get("op")
            )
            if r.method == "POST" and "AutoSeekOperation" in (r.post_data or "")
            else None
        ),
    )
    open_scene(page, base_url, scene)
    button = page.locator(".auto-seek-button")
    expect(button).to_have_attribute("data-state", "busy")
    page.wait_for_timeout(3000)
    status = operation(op="status")
    assert not status["ready"] and not status["downloading"], status
    assert "ensure" not in requested  # the setting is respected
    page.locator(".video-js video").evaluate(
        "video => { video.muted = true; return video.play(); }"
    )
    page.wait_for_function("() => document.querySelector('.video-js video').currentTime > 1")
    assert errors == []
