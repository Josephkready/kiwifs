"""Land on the reader: the configured start page (index/recent.md), scrolled to the end."""

import re

from _helpers import wait_for_note

NAME = "start-page"
DESCRIPTION = ("Open the Mind reader at / ; it redirects to the 'Recently Edited' start page, a list of long "
               "note links with summaries. Scroll to the end of the list and open the Backlinks panel.")
SOURCE = "standard"
START = "/"


def run(page, vd):
    wait_for_note(page, "Recently Edited")
    vd.mark("start page rendered")
    page.get_by_role("link", name=re.compile("extremely long title")).scroll_into_view_if_needed()
    vd.mark("end of list")
    page.get_by_role("button", name="Backlinks").click()
    vd.mark("backlinks panel")
