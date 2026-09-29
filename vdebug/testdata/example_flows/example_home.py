"""Land on the home page, open the main navigation, and follow the first link.

A STANDARD flow (hand-written from the app's core journeys). Copy this file per flow.
Mined flows look the same, with SOURCE = "mined:<cluster-id>" from `flowstore.py mine`.

Contract: module-level NAME/DESCRIPTION/SOURCE/START (+ optional VIEWPORTS) and
run(page, vd). vdebug has already opened START and taken a "start" mark before run()
is called, and takes an "end" mark after it returns. Call vd.mark("<label>") at every
state worth judging — each mark is a crisp frame + DOM layout checks for the judge.

Locators: prefer get_by_role / get_by_test_id / get_by_label over CSS — they survive
restyling, which is exactly what this tool provokes.
"""

NAME = "home-nav"
DESCRIPTION = "Home page -> open nav -> first nav link"
SOURCE = "standard"
START = "/"
# VIEWPORTS = ["mobile", "tablet"]   # restrict a flow to some presets (default: all)


def run(page, vd):
    menu = page.get_by_role("button", name="Menu")
    if menu.count() and menu.first.is_visible():   # hamburger only exists on small viewports
        menu.first.click()
        vd.mark("nav open")
    page.get_by_role("navigation").get_by_role("link").first.click()
    vd.mark("first nav page")
