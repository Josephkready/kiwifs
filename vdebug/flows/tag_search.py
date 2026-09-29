"""Click a tag chip on a note: search opens filtered to that tag."""

from _helpers import NOTE, wait_for_note

NAME = "tag-search"
DESCRIPTION = "On a note, click its 'networking' tag chip; the search dialog opens filtered to tag:networking."
SOURCE = "standard"
START = NOTE


def run(page, vd):
    wait_for_note(page, "Network Segmentation Design")
    # Tag chips are clickable <div>s with no role (KiwiPage.tsx tag badges), so role locators can't
    # reach them; exact text is the least brittle option until they become buttons.
    page.locator("main").get_by_text("networking", exact=True).first.click()
    page.get_by_role("dialog").wait_for()
    page.get_by_role("option").first.wait_for()
    vd.mark("tag search results")
    page.keyboard.press("Escape")
    page.get_by_role("dialog").wait_for(state="hidden")
    vd.mark("dialog closed")
