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
