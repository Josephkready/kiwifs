// Classification of the server-sent event names the reader listens for, split by
// what each one should refresh in the UI.
//
// This exists because a comment used to reload the whole page. The App-level SSE
// handler bumped ONE page-wide `refreshKey` for every event in a single list —
// including `comment.add`/`comment.delete`. That key re-fetches the note body,
// local note, and analytics in KiwiPage, so posting a comment (whose echo the
// author's own browser receives over SSE) reloaded the entire page. But a comment
// never changes the note markdown or the tree — only the comments list — so its
// event must refresh comments ONLY.
//
// Keeping the two sets here, as data with a unit test, makes the invariant
// checkable: a comment event must never appear in PAGE_REFRESH_EVENTS.

// Events that mutate the note tree or a note's content — these justify a
// page-wide refresh (re-fetch body/tree/analytics) and a tree reconcile.
export const PAGE_REFRESH_EVENTS = ["write", "delete", "bulk"] as const;

// Events that only touch inline comments (stored in .kiwi/comments/, never the
// note markdown or the tree). These refresh the comments list + count ONLY.
export const COMMENT_EVENTS = [
  "comment.add",
  "comment.delete",
  "comment.resolve",
] as const;

export type SSEEventName =
  | (typeof PAGE_REFRESH_EVENTS)[number]
  | (typeof COMMENT_EVENTS)[number];

export type SSEEventClass = "page" | "comment" | "other";

// classifySSEEvent maps a raw event name to what it should refresh. Unknown names
// are "other" so the caller can ignore them rather than force a page reload.
export function classifySSEEvent(name: string): SSEEventClass {
  if ((PAGE_REFRESH_EVENTS as readonly string[]).includes(name)) return "page";
  if ((COMMENT_EVENTS as readonly string[]).includes(name)) return "comment";
  return "other";
}
