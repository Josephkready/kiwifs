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
