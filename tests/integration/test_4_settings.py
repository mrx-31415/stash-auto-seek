"""Auto Seek's settings under Settings → Plugins: the Start at dropdown, the
act grid with its search, and the model dropdown, saved as the backend reads
them, with Stash's own fields for the other settings."""

from __future__ import annotations

import time

from conftest import PLUGIN_ID, dismiss_modals
from playwright.sync_api import Page, expect

READ = f'{{ configuration {{ plugins(include: ["{PLUGIN_ID}"]) }} }}'


def saved(gql) -> dict:
    return gql(READ)["configuration"]["plugins"].get(PLUGIN_ID) or {}


def eventually(gql, check, timeout: float = 10) -> dict:
    """The saved settings once `check` holds (Stash saves after a moment)."""
    deadline = time.monotonic() + timeout
    while not check(current := saved(gql)) and time.monotonic() < deadline:
        time.sleep(0.2)
    assert check(current), current
    return current


def open_settings(page: Page, base_url: str):
    page.goto(f"{base_url}/settings?tab=plugins", wait_until="domcontentloaded")
    dismiss_modals(page)
    # The plugin's own group, headed "Auto Seek (version)" (the hooks list
    # elsewhere on the tab has an "Auto Seek" heading too).
    heading = page.locator(".setting > div > h3", has_text="Auto Seek (")
    group = heading.locator("xpath=ancestor::div[contains(@class, 'setting-group')][1]")
    expect(group).to_have_count(1, timeout=30_000)
    expect(group).to_be_visible(timeout=30_000)
    # Newer Stash collapses a plugin's settings (v0.31.1 shows them open).
    collapse = group.locator(":scope > .setting .setting-group-collapse-button")
    if collapse.count():
        collapse.click()
    expect(group.locator(".auto-seek-settings")).to_be_visible()
    return group


def pick(page: Page, group, row: str, label: str) -> None:
    group.locator(f".{row} .react-select__control").click()
    page.locator(".react-select__option", has_text=label).first.click()


def test_start_and_model_settings(page, base_url, gql, configure, errors) -> None:
    configure(startStage="", accurateModel=False)
    group = open_settings(page, base_url)
    # Stash's own fields stay for the rest, not for the two the panel shows.
    headings = group.locator(".plugin-settings .setting h3")
    expect(headings.filter(has_text="Lead-in (seconds)")).to_have_count(1)
    expect(headings.filter(has_text="Use the accurate model")).to_have_count(0)
    expect(group.locator(".auto-seek-start .react-select__single-value")).to_have_text(
        "Oral, hands or sex"
    )
    expect(group.locator(".auto-seek-chip.is-on")).to_have_count(20)

    pick(page, group, "auto-seek-start", "Sex positions only")
    expect(group.locator(".auto-seek-chip.is-on")).to_have_count(9)
    eventually(gql, lambda s: s.get("startStage") == "sex")

    # Search narrows the grid; Enter on the only match toggles it.
    search = group.locator(".auto-seek-search")
    search.fill("kiss")
    expect(group.locator(".auto-seek-chip")).to_have_text(["Kissing"])
    search.press("Enter")
    expect(group.locator(".auto-seek-start .react-select__single-value")).to_have_text(
        "Your own pick · 10 acts"
    )
    eventually(gql, lambda s: s.get("startStage", "").startswith("acts: kissing, cowgirl"))
    search.fill("")

    # A group name counts all of its acts.
    group.locator(".auto-seek-group-name", has_text="Oral").click()
    eventually(gql, lambda s: "oral on him" in s.get("startStage", ""))

    pick(page, group, "auto-seek-model", "Accurate (ViT-B/16)")
    # Saving one keeps the others.
    final = eventually(gql, lambda s: s.get("accurateModel") is True)
    assert final["startStage"].startswith("acts:")
    assert errors == []
