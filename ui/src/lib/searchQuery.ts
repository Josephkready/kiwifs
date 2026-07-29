import type { MetaFilter } from "./api";

export function parseFieldFilters(q: string): { text: string; filters: MetaFilter[] } {
  const filters: MetaFilter[] = [];
  const textParts: string[] = [];
  for (const token of q.split(/\s+/)) {
    const colonIdx = token.indexOf(":");
    if (colonIdx > 0 && colonIdx < token.length - 1) {
      const field = token.slice(0, colonIdx);
      const value = token.slice(colonIdx + 1);
      if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(field)) {
        const path = field === "tag" || field === "tags" ? "$.tags[*]" : `$.${field}`;
        filters.push({ field: path, op: "=", value });
        continue;
      }
    }
    textParts.push(token);
  }
  return { text: textParts.join(" "), filters };
}
