"""Type into the knowledge graph's Highlight box, then dismiss it (types on phones and iPads)."""

from _helpers import NOTE, wait_for_note

NAME = "graph-highlight"
DESCRIPTION = ("Open the Knowledge graph view, tap its 'Highlight...' box and type 'ada' to highlight the "
               "matching node (the on-screen keyboard is up on phones and iPads), then tap 'Fit graph', "
               "which closes the keyboard.")
SOURCE = "standard"
START = NOTE


def run(page, vd):
    wait_for_note(page, "Network Segmentation Design")
    page.get_by_role("button", name="Knowledge graph").click()
    page.get_by_role("button", name="Fit graph").wait_for()
    page.wait_for_timeout(1500)  # let the force layout settle on camera
    box = page.get_by_placeholder("Highlight...")
    box.click()
    box.press_sequentially("ada", delay=60)
    page.wait_for_timeout(500)
    vd.mark("typing a highlight")
    page.get_by_role("button", name="Fit graph").click()  # tapping a button blurs: keyboard closes
    page.wait_for_timeout(1000)
    vd.mark("highlight kept, keyboard closed")
