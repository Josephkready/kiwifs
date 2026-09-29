"""A broken deep link: the page-not-found state, then back to the index."""

NAME = "page-not-found"
DESCRIPTION = ("Open a deep link to a note that does not exist: the reader shows its 'Page not found' empty "
               "state; press 'Go to index' to recover.")
SOURCE = "standard"
START = "/page/does/not/exist.md"


def run(page, vd):
    page.get_by_text("Page not found").wait_for()
    vd.mark("not found state")
    page.get_by_role("button", name="Go to index").click()
    page.get_by_text("Page not found").wait_for(state="hidden")
    vd.mark("after go to index")
