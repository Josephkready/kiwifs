"""Browse the file tree: open the sidebar, expand a folder, open a note from it."""

from _helpers import open_sidebar, wait_for_note

NAME = "sidebar-tree"
DESCRIPTION = ("Browse notes via the sidebar file tree: open the sidebar (a drawer on phones), expand the "
               "'planning' folder, and open the garden plan note from it.")
SOURCE = "standard"
START = "/page/index/recent.md"


def run(page, vd):
    wait_for_note(page, "Recently Edited")
    if open_sidebar(page):
        vd.mark("sidebar drawer open")
    page.get_by_role("treeitem", name="planning").click()
    page.get_by_role("treeitem", name="garden-plan-2026q4").wait_for()
    vd.mark("folder expanded")
    page.get_by_role("treeitem", name="garden-plan-2026q4").click()
    wait_for_note(page, "Garden plan 2026Q4")
    vd.mark("note opened from tree")
