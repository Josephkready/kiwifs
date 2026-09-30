- Wide tables and long code lines sit in `overflow-x: auto` scrollers by design; content
  reachable by scrolling sideways is not clipped or cut off.
- The sticky breadcrumb bar scrolls over the note content by design as the page scrolls.
- The article is a centred `max-w-6xl` column with the table of contents docked to the right
  at wide viewports (2K/4K/half-2K/third-4K) — a narrow reading column there is intentional,
  not a layout bug.
- The knowledge graph's force-directed layout settles for a moment (nodes still drifting)
  before "Fit graph" is clicked; that settling motion is expected, not a glitch.
- Task-list checkboxes in a rendered note are disabled by design (the reader is read-only).
  The knowledge graph's option checkboxes are disabled controls sitting inside larger
  clickable labels; that is also intentional.
- Long node labels in the knowledge graph are truncated with an ellipsis and shown in full
  on hover — this is not clipped text.
- Before "Fit graph" is pressed the force layout can leave a node near an edge with its label
  partly off-canvas, and labels in dense clusters can touch or overlap. The graph is a
  canvas drawing that the user pans/zooms/fits, so neither is a DOM layout bug.
- On iPhone and iPad the grey panel at the bottom is the simulated on-screen keyboard. It
  opens when a text field (search box, "Filter pages…", graph "Highlight...") is focused and
  closes on the tap that follows; a single frame where it is still drawn while the next
  screen is loading is the close lagging the tap by one video frame (measured: it closes
  within 40 ms of the tap), not a keyboard that stays open.
