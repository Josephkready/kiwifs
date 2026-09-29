"""Shared helpers for the kiwifs vdebug flows (files starting with _ are not flows)."""

import re

NOTE = "/page/design/network-segmentation-design.md"


def wait_for_note(page, title_re):
    """Wait until the reader has rendered the note whose H1 matches title_re."""
    page.get_by_role("heading", level=1, name=re.compile(title_re)).first.wait_for()


def open_search(page):
    """Open the search dialog and wait until its input has focus (keys typed earlier are lost)."""
    page.get_by_test_id("open-search").click()
    box = page.get_by_role("dialog").get_by_placeholder("Search…")
    box.wait_for()
    page.wait_for_function("document.activeElement && document.activeElement.placeholder === 'Search…'")
    return box


def open_sidebar(page):
    """The sidebar starts collapsed on narrow screens; open it if its toggle says so."""
    expand = page.get_by_role("button", name="Expand sidebar")
    if expand.count() and expand.first.is_visible():
        expand.first.click()
        page.get_by_role("tree").first.wait_for()
        return True
    return False


# Gesture helpers (from the video-debugger template): Playwright's page.mouse covers drags
# and wheel zoom, but has no multi-touch, so `pinch` drives Chrome's DevTools protocol
# directly (needs a touch context — vdebug's mobile and tablet presets have one). Useful for
# the knowledge graph view (pan/zoom the force layout) if a flow ever needs to drive that.

def _centre(locator):
    box = locator.bounding_box()
    if box is None:
        raise ValueError("element is not visible")
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2


def drag(page, locator, dx: float, dy: float, *, steps: int = 12) -> None:
    """Press in the middle of `locator`, move by (dx, dy) in `steps` moves, release."""
    x, y = _centre(locator)
    page.mouse.move(x, y)
    page.mouse.down()
    for i in range(1, steps + 1):
        page.mouse.move(x + dx * i / steps, y + dy * i / steps)
    page.mouse.up()


def wheel_zoom(page, locator, delta_y: float, *, at: tuple[float, float] = (0.5, 0.5)) -> None:
    """Scroll-wheel over a point of `locator` (fractions of its box; default the centre)."""
    box = locator.bounding_box()
    if box is None:
        raise ValueError("element is not visible")
    page.mouse.move(box["x"] + box["width"] * at[0], box["y"] + box["height"] * at[1])
    page.mouse.wheel(0, delta_y)


def pinch(page, locator, scale: float, *, steps: int = 10, spread: float = 40) -> None:
    """Two-finger pinch around the middle of `locator`: scale > 1 zooms in, < 1 zooms out."""
    cdp = page.context.new_cdp_session(page)
    x, y = _centre(locator)

    def points(d):
        return [{"x": x - d, "y": y, "id": 0}, {"x": x + d, "y": y, "id": 1}]

    try:
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": points(spread)})
        for i in range(1, steps + 1):
            d = spread * (1 + (scale - 1) * i / steps)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": points(d)})
            page.wait_for_timeout(16)
    finally:
        try:  # always end the touch sequence, or the next gesture on this page starts mid-touch
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        finally:
            cdp.detach()
