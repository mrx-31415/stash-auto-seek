"""The act timeline's controls on Stash's own player (review mode comes from
the development plugin, installed beside Auto Seek here), with a fixed timeline
answer in place of a scan (the page's "timeline" request is answered here),
so the rows don't depend on what the model sees in the synthetic clip."""

from __future__ import annotations

import json
import re

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
    page.wait_for_function(
        "() => document.querySelector('.auto-seek-timeline').classList.contains('is-playing')"
    )
    page.locator(".video-js video").evaluate("video => video.pause()")
    page.wait_for_function(
        "() => !document.querySelector('.auto-seek-timeline').classList.contains('is-playing')"
    )
    assert errors == []


def test_the_name_steps_through_the_act(page, base_url, timeline, errors) -> None:
    open_timeline(page, base_url, timeline)
    video = page.locator(".video-js video")
    name = page.locator(".auto-seek-tl-row[data-act='kissing'] .auto-seek-tl-name")
    # Where it starts (5 s, standing for the first stretch), the next
    # stretch's peak (30 s), then round to the start again.
    for expected, text in (
        (5, "Kissing 1/2 · 0:05"),
        (30, "Kissing 2/2 · 0:30"),
        (5, "(back to the first)"),
    ):
        name.click()
        expect(page.locator(".auto-seek-toast").first).to_contain_text(text)
        assert current_time(page) == pytest.approx(expected, abs=0.5)
        video.evaluate("video => video.pause()")
    assert errors == []


def test_reviewing_keeps_a_paused_video_paused(page, base_url, timeline, errors) -> None:
    open_timeline(page, base_url, timeline)
    video = page.locator(".video-js video")
    name = page.locator(".auto-seek-tl-row[data-act='kissing'] .auto-seek-tl-name")
    # Outside review mode a tap plays from there.
    name.click()
    page.wait_for_function("() => !document.querySelector('.video-js video').paused")
    video.evaluate("video => video.pause()")
    page.locator(".auto-seek-tl-review").click()
    # While reviewing: the act's name and its lane move the video without
    # starting it.
    name.click()
    assert current_time(page) == pytest.approx(30, abs=0.5)
    lane = page.locator(".auto-seek-tl-lane[data-act='kissing']")
    box = lane.bounding_box()
    page.mouse.click(box["x"] + box["width"] * 0.25, box["y"] + box["height"] / 2)
    assert current_time(page) < 20
    page.wait_for_timeout(500)
    assert video.evaluate("video => video.paused")
    assert errors == []


def test_marks_show_as_frames_below_the_timeline(
    page, base_url, timeline, dev_operation, errors
) -> None:
    open_timeline(page, base_url, timeline)
    page.locator(".auto-seek-tl-review").click()
    marks = page.locator(".auto-seek-tl-marks")
    expect(marks).to_be_hidden()  # none yet
    name = page.locator(".auto-seek-tl-row[data-act='kissing'] .auto-seek-tl-name")
    name.click()  # to 5 s
    page.locator(
        ".auto-seek-tl-row[data-act='kissing'] .auto-seek-tl-judge button[data-verdict='1']"
    ).click()
    name.click()  # to 30 s
    page.locator(
        ".auto-seek-tl-row[data-act='kissing'] .auto-seek-tl-judge button[data-verdict='0']"
    ).click()
    expect(marks).to_be_visible()
    expect(marks.locator(".auto-seek-tl-marks-count")).to_have_text("2")
    cards = marks.locator(".auto-seek-mark-card")
    expect(cards).to_have_count(2)
    expect(cards.nth(0).locator("figcaption")).to_have_text("✓ Kissing")
    expect(cards.nth(0).locator(".auto-seek-mark-time")).to_have_text("0:05")
    expect(cards.nth(1)).to_have_class("auto-seek-mark-card no")
    # The exact frame, cut by the server.
    expect(cards.nth(0).locator("img")).to_be_visible(timeout=20_000)
    # A tap on the frame goes there and leaves the video paused.
    cards.nth(0).locator(".auto-seek-mark-shot").click()
    assert current_time(page) == pytest.approx(5, abs=0.5)
    assert page.locator(".video-js video").evaluate("video => video.paused")
    # × takes the mark back, on the server too.
    cards.nth(0).locator(".auto-seek-mark-remove").click()
    expect(cards).to_have_count(1)
    expect(page.locator(".auto-seek-toast").first).to_contain_text(
        "Mark taken back: Kissing at 0:05"
    )
    cards.nth(0).locator(".auto-seek-mark-remove").click()
    expect(marks).to_be_hidden()
    page.wait_for_timeout(500)
    assert dev_operation(op="reviews", scene_id=timeline["id"])["reviews"] == []
    assert errors == []


QUEUE = "/root/.stash/plugins/auto-seek-dev/data/review_queue.json"
# A one-finger swipe of `dx` pixels across `element`, as pointer events.
SWIPE = """(element, dx) => {
  const box = element.getBoundingClientRect();
  const x = box.left + box.width / 2, y = box.top + box.height / 2;
  const send = (type, at, t) => element.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true,
    clientX: at, clientY: y,
  }));
  send("pointerdown", x);
  for (let i = 1; i <= 6; i++) send("pointermove", x + (dx * i) / 6);
  send("pointerup", x + dx);
}"""


def test_the_review_queue_steps_through_its_spots_from_the_keyboard(
    page, base_url, timeline, dev_operation, in_stash, errors
) -> None:
    spots = [
        {"t": 30, "act": "kissing", "yours": 0.1, "teacher": 0.92, "kind": "disagree"},
        {"t": 10, "act": "kissing", "yours": 0.95, "teacher": 0.2, "kind": "disagree"},
    ]
    queue = {
        "models": {"yours": "a", "teacher": "b"},
        "scenes": [{"id": timeline["id"], "spots": spots}],
    }
    in_stash(f"mkdir -p $(dirname {QUEUE}) && cat > {QUEUE} <<'EOF'\n{json.dumps(queue)}\nEOF")
    try:
        # The entry point: "Review 1" in Stash's navigation bar opens the scene.
        page.goto(f"{base_url}/scenes", wait_until="domcontentloaded")
        nav = page.locator(".auto-seek-dev-nav")
        expect(nav).to_contain_text("Review 1", timeout=30_000)
        nav.locator("a").click()
        expect(page).to_have_url(re.compile(rf"/scenes/{timeline['id']}"))
        open_timeline(page, base_url, timeline)
        # Opened from the queue, review mode is already on.
        expect(page.locator(".auto-seek-timeline")).to_have_class(re.compile(r"\bis-reviewing\b"))
        page.locator(".video-js video").evaluate("video => { video.currentTime = 0; }")
        bar = page.locator(".auto-seek-dev-queue")
        expect(bar).to_contain_text("2 of 2 spots left")
        expect(page.locator(".auto-seek-dev-spot")).to_have_count(2)
        # n: the first spot after the playhead, paused on it, its act picked out.
        page.keyboard.press("n")
        assert current_time(page) == pytest.approx(10, abs=0.5)
        expect(page.locator(".auto-seek-tl-row[data-act='kissing']")).to_have_class(
            re.compile(r"\bis-spot\b")
        )
        expect(bar).to_contain_text("this model 95%, stronger 20%")
        # The same question on the video itself, to answer without looking away.
        card = page.locator(".video-js .auto-seek-dev-card")
        expect(card).to_contain_text("Kissing?")
        expect(card).to_contain_text("this model 95% · stronger 20%")
        # x marks its act not there, and goes on to the next spot.
        page.keyboard.press("x")
        expect(bar).to_contain_text("1 of 2 spots left")
        page.wait_for_function(
            "() => Math.abs(document.querySelector('.video-js video').currentTime - 30) < 0.5"
        )
        # On a phone: a swipe right on the video says it's here.
        card.evaluate(SWIPE, 20)  # too short even for a flick: springs back
        expect(bar).to_contain_text("1 of 2 spots left")
        card.evaluate(SWIPE, 160)
        expect(bar).to_contain_text("0 of 2 spots left")
        expect(card).to_be_hidden()
        assert page.locator(".video-js video").evaluate("video => video.paused")
        marks = dev_operation(op="reviews", scene_id=timeline["id"])["reviews"]
        assert [(round(t), act, verdict) for t, act, verdict in marks] == [
            (10, "kissing", 0),
            (30, "kissing", 1),
        ]
        assert errors == []
    finally:
        in_stash(f"rm -f {QUEUE}")
        for t, act, _ in dev_operation(op="reviews", scene_id=timeline["id"])["reviews"]:
            dev_operation(op="review", scene_id=timeline["id"], t=t, act=act, verdict=None)
