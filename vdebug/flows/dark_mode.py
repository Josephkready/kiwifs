"""Switch to dark mode, look at a note and the search dialog, switch back."""

from _helpers import NOTE, open_search, wait_for_note

NAME = "dark-mode"
DESCRIPTION = ("Toggle the header's dark-mode button on a long note, open the search dialog in dark mode, "
               "close it, and switch back to light mode.")
SOURCE = "standard"
START = NOTE


def run(page, vd):
    wait_for_note(page, "Network Segmentation Design")
    page.get_by_role("button", name="Dark mode").click()
    page.get_by_role("button", name="Light mode").wait_for()
    vd.mark("dark note")
    open_search(page)
    page.keyboard.type("garden", delay=60)
    page.get_by_role("option").first.wait_for()
    vd.mark("dark search")
    page.keyboard.press("Escape")
    page.get_by_role("button", name="Light mode").click()
    page.get_by_role("button", name="Dark mode").wait_for()
    vd.mark("back to light")
