"""The act timeline's controls on Stash's own player, with a fixed timeline
answer in place of a scan (the page's "timeline" request is answered here),
so the rows don't depend on what the model sees in the synthetic clip."""

from __future__ import annotations

import json

import pytest
from playwright.sync_api import Page, Route, expect
from test_2_player import current_time, marked, open_scene  # noqa: F401 (fixture)

ACTS = ["nothing yet", "kissing", "oral on him"]
# Kissing peaks at 10 s and again at 30 s; a one-frame dip at 20 s.
FRAMES = [
    [0, [90, 10, 0]],
    [5, [20, 60, 0]],
    [10, [10, 95, 0]],
    [15, [40, 30, 0]],
    [20, [80, 5, 0]],
    [25, [70, 6, 0]],
    [30, [10, 85, 0]],
    [35, [50, 40, 0]],
]


def answer(duration: float) -> dict:
    return {
        "state": "done", "acts": ACTS, "frames": FRAMES, "firsts": {"kissing": 5},
        "duration": duration, "threshold": 0.8, "spacing": 5, "scanned": 8, "planned": 8,
        "reviews": [],
    }  # fmt: skip


@pytest.fixture
def timeline(page: Page, marked):  # noqa: F811
    """Answer the page's timeline requests with the fixed answer."""

    def handle(route: Route) -> None:
        body = route.request.post_data or ""
        if '"op":"timeline"' in body.replace(" ", ""):
            data = {"data": {"runPluginOperation": answer(marked["duration"])}}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        else:
            route.continue_()

    page.route("**/graphql", handle)
    return marked


def open_timeline(page: Page, base_url: str, scene) -> None:
    open_scene(page, base_url, scene)
    page.locator(".video-js video").evaluate("video => { video.muted = true; video.pause(); }")
    expect(page.locator(".auto-seek-tl-row[data-act='kissing']")).to_be_visible(timeout=30_000)


def test_the_playhead_is_a_line_that_brightens_while_playing(
    page, base_url, timeline, errors
) -> None:
    open_timeline(page, base_url, timeline)
    panel = page.locator(".auto-seek-timeline")
    expect(panel.locator(".auto-seek-tl-playhead")).to_be_visible()
    expect(panel).not_to_have_class("auto-seek-timeline is-playing")
    page.locator(".video-js video").evaluate("video => video.play()")
    page.wait_for_function("() => document.querySelector('.auto-seek-timeline').classList.contains('is-playing')")
    page.locator(".video-js video").evaluate("video => video.pause()")
    page.wait_for_function("() => !document.querySelector('.auto-seek-timeline').classList.contains('is-playing')")
    assert errors == []


def test_next_peak_steps_through_an_acts_peaks(page, base_url, timeline, errors) -> None:
    open_timeline(page, base_url, timeline)
    step = page.locator(".auto-seek-tl-row[data-act='kissing'] .auto-seek-tl-next")
    step.click()
    assert current_time(page) == pytest.approx(10, abs=0.5)
    page.locator(".video-js video").evaluate("video => video.pause()")
    step.click()
    assert current_time(page) == pytest.approx(30, abs=0.5)
    page.locator(".video-js video").evaluate("video => video.pause()")
    step.click()
    expect(page.locator(".auto-seek-toast").first).to_contain_text("No later peak of Kissing")
    assert errors == []


def test_reviewing_keeps_a_paused_video_paused(
    page, base_url, timeline, configure, errors
) -> None:
    configure(enableReview=True)
    open_timeline(page, base_url, timeline)
    video = page.locator(".video-js video")
    # Outside review mode a tap plays from there.
    page.locator(".auto-seek-tl-row[data-act='kissing'] .auto-seek-tl-next").click()
    page.wait_for_function("() => !document.querySelector('.video-js video').paused")
    video.evaluate("video => video.pause()")
    page.locator(".auto-seek-tl-review").click()
    # While reviewing: the act's name, its next peak and its lane all move
    # the video without starting it.
    page.locator(".auto-seek-tl-row[data-act='kissing'] .auto-seek-tl-name").click()
    assert current_time(page) == pytest.approx(5, abs=0.5)
    page.locator(".auto-seek-tl-row[data-act='kissing'] .auto-seek-tl-next").click()
    assert current_time(page) == pytest.approx(10, abs=0.5)
    lane = page.locator(".auto-seek-tl-lane[data-act='kissing']")
    box = lane.bounding_box()
    page.mouse.click(box["x"] + box["width"] * 0.75, box["y"] + box["height"] / 2)
    assert current_time(page) > 20
    page.wait_for_timeout(500)
    assert video.evaluate("video => video.paused")
    assert errors == []
