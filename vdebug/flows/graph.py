"""Open the knowledge graph view from a note, fit it, and toggle back to the note."""

from _helpers import NOTE, wait_for_note

NAME = "knowledge-graph"
DESCRIPTION = ("Open the Knowledge graph view from the header toolbar: a force-directed graph of the notes "
               "with filters and a communities legend; fit it to the screen, then toggle back to the note.")
SOURCE = "standard"
START = NOTE


def run(page, vd):
    wait_for_note(page, "Network Segmentation Design")
    toggle = page.get_by_role("button", name="Knowledge graph")
    toggle.click()
    page.get_by_role("button", name="Fit graph").wait_for()
    page.wait_for_timeout(1500)  # let the force layout settle on camera
    vd.mark("graph open")
    page.get_by_role("button", name="Fit graph").click()
    page.wait_for_timeout(1000)
    vd.mark("graph fitted")
    toggle.click()
    wait_for_note(page, "Network Segmentation Design")
    vd.mark("back to note")
