import type {
  MetaFilter,
  MetaResponse,
  SearchResponse,
  SearchSuggestion,
  SemanticResponse,
} from "./api";

export type SearchHit = {
  path: string;
  snippet?: string;
  score?: number;
};

type SearchClient = {
  meta: (opts: { where?: MetaFilter[]; limit?: number }) => Promise<MetaResponse>;
  search: (q: string, opts?: { modifiedAfter?: string }) => Promise<SearchResponse>;
  semanticSearch: (
    q: string,
    topK?: number,
    offset?: number,
    opts?: { modifiedAfter?: string },
  ) => Promise<SemanticResponse>;
};

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

export async function executeSearch(
  client: SearchClient,
  query: string,
  opts?: { modifiedAfter?: string },
): Promise<{ results: SearchHit[]; suggestions: SearchSuggestion[] }> {
  const { text, filters } = parseFieldFilters(query);
  const searchQ = text.trim();
  if (!searchQ && filters.length === 0) return { results: [], suggestions: [] };

  const metaPromise = filters.length > 0
    ? client.meta({ where: filters, limit: 200 })
        .then((response) => new Set(response.results.map((result) => result.path)))
        // A metadata failure must not silently broaden a filtered search.
        .catch(() => new Set<string>())
    : Promise.resolve(null as Set<string> | null);
  const ftsPromise = searchQ
    ? client.search(searchQ, opts).catch(() => null)
    : Promise.resolve(null);
  const semanticPromise = searchQ
    ? client.semanticSearch(searchQ, 15, 0, opts).catch(() => null)
    : Promise.resolve(null);

  const [ftsResponse, semanticResponse, metaPaths] = await Promise.all([
    ftsPromise,
    semanticPromise,
    metaPromise,
  ]);
  const merged = new Map<string, SearchHit>();

  for (const result of ftsResponse?.results ?? []) {
    merged.set(result.path, {
      path: result.path,
      snippet: result.snippet,
      score: result.score,
    });
  }

  const bestSemantic = new Map<string, SemanticResponse["results"][number]>();
  for (const result of semanticResponse?.results ?? []) {
    const previous = bestSemantic.get(result.path);
    if (!previous || result.score > previous.score) bestSemantic.set(result.path, result);
  }
  for (const [path, semantic] of bestSemantic) {
    const existing = merged.get(path);
    if (existing) {
      existing.score = (existing.score ?? 0) + (semantic.score ?? 0);
    } else {
      merged.set(path, {
        path,
        snippet: highlightTerms(semantic.snippet, searchQ),
        score: semantic.score,
      });
    }
  }

  let results = Array.from(merged.values());
  if (metaPaths) {
    results = results.length > 0
      ? results.filter((result) => metaPaths.has(result.path))
      : Array.from(metaPaths).map((path) => ({ path }));
  }
  results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return {
    results,
    suggestions: results.length === 0 ? (ftsResponse?.suggestions ?? []) : [],
  };
}

function highlightTerms(text: string, query: string): string {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return escapeHtml(text);
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
  return escapeHtml(text).replace(pattern, "<mark>$1</mark>");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
