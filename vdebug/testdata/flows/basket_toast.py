"""Fixture flow for the planted ANIMATION bug in testdata/broken.html (not a template).

Written the way a careful flow author would: click, wait until animations have finished,
then mark the settled state. That is what the current setup captures — the glitch lives
entirely inside the transition, between marks. judge_eval.py uses this to measure whether
a judge can see motion bugs at all.
"""

NAME = "basket-toast"
DESCRIPTION = "Add an item to the basket and see the confirmation toast"
SOURCE = "standard"
START = "/"

SETTLED = "() => document.getAnimations().every(a => a.playState !== 'running')"


def run(page, vd):
    page.get_by_test_id("buy").click()
    page.get_by_role("status").wait_for()
    page.wait_for_function(SETTLED)
    vd.mark("added to basket")
