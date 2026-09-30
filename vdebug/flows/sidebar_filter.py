"""Filter the sidebar file tree by typing, then open a match (types on phones and iPads)."""

from _helpers import open_sidebar, wait_for_note

NAME = "sidebar-filter"
DESCRIPTION = ("Find a note by name from the sidebar: open the sidebar (a drawer on phones), tap the "
               "'Filter pages…' box, type 'garden' (the on-screen keyboard is up on phones and iPads), "
               "then open the matching garden plan note from the filtered tree.")
SOURCE = "standard"
START = "/page/index/recent.md"


def run(page, vd):
    wait_for_note(page, "Recently Edited")
    if open_sidebar(page):
        vd.mark("sidebar drawer open")
    box = page.get_by_label("Filter file tree")
    box.click()
    box.press_sequentially("garden", delay=60)
    page.get_by_role("treeitem", name="garden-plan-2026q4").wait_for()
    vd.mark("typing a filter")
    page.get_by_role("treeitem", name="garden-plan-2026q4").click()  # tapping the result blurs: keyboard closes
    wait_for_note(page, "Garden plan 2026Q4")
    vd.mark("note opened from filtered tree")
