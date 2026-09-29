"""Search: open the search dialog, type a query, open the top result."""

from _helpers import open_search, wait_for_note

NAME = "search"
DESCRIPTION = ("Full-text search: tap the header search box, type 'vlan', look at the ranked results with "
               "highlighted snippets and folder filter chips, then open the top result.")
SOURCE = "standard"
START = "/page/index/recent.md"


def run(page, vd):
    wait_for_note(page, "Recently Edited")
    open_search(page)
    vd.mark("search dialog open")
    page.keyboard.type("vlan", delay=60)
    page.get_by_role("option").first.wait_for()
    vd.mark("results for vlan")
    page.get_by_role("option").first.click()
    wait_for_note(page, "Network Segmentation Design")
    vd.mark("top result opened")
