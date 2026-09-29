"""Read a long note: properties, a wide table, a code block, then follow a wikilink."""

import re

from _helpers import NOTE, wait_for_note

NAME = "read-long-note"
DESCRIPTION = ("Read a long design note: expand its Properties, scroll through a 7-column table, a code block "
               "with long lines and a long URL, then follow a [[wikilink]] to another note.")
SOURCE = "standard"
START = NOTE


def run(page, vd):
    wait_for_note(page, "Network Segmentation Design")
    main = page.locator("main")
    main.get_by_role("button", name=re.compile("Properties")).click()
    vd.mark("properties expanded")
    main.get_by_role("table").first.scroll_into_view_if_needed()
    vd.mark("wide table")
    main.locator("pre").first.scroll_into_view_if_needed()
    vd.mark("code block")
    main.get_by_role("link", name=re.compile("ada", re.I)).first.click()
    wait_for_note(page, "Ada Lovelace")
    vd.mark("followed wikilink")
