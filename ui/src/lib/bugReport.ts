export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_LONG_EDGE = 1600;
export const MIN_DESCRIPTION = 10;
export const MAX_DESCRIPTION = 8000;
export const DRAFT_KEY = "kiwifs-bug-report-draft";
export const POLL_INTERVAL_MS = 4000;
export const POLL_MAX_MS = 2 * 60 * 1000;

export type SyncStatus = "pending-sync" | "queued" | "filed" | "retry" | "failed" | "uncertain";

export interface BugContext {
  path?: string;
  slug?: string;
  route?: string;
  view?: string;
  viewport?: string;
  theme?: string;
  search_query?: string;
  selected_text?: string;
}

export interface PreviousReport {
  id: number;
  created_at: string;
  title: string;
  sync_status: SyncStatus;
  issue_url?: string;
}

export interface StagedImage {
  id: string;
  blob: Blob;
  previewUrl: string;
  name: string;
}

// crypto.randomUUID only exists in secure contexts; a LAN http origin throws
// before the save and would leave the submit button stuck.
export function newUUID(c: Crypto | undefined = globalThis.crypto): string {
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      /* insecure context: fall through */
    }
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h
    .slice(8, 10)
    .join("")}-${h.slice(10).join("")}`;
}

/** Scale so the long edge is at most `max`; never upscale. */
export function fitWithin(w: number, h: number, max = MAX_LONG_EDGE): { width: number; height: number } {
  const long = Math.max(w, h);
  if (long <= max) return { width: w, height: h };
  const k = max / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

export interface ImageIO {
  decode(file: Blob): Promise<{ width: number; height: number; source: unknown }>;
  encode(source: unknown, width: number, height: number, type: string, quality: number): Promise<Blob | null>;
}

export class ImageError extends Error {}

export const browserImageIO: ImageIO = {
  async decode(file) {
    const bmp = await createImageBitmap(file);
    return { width: bmp.width, height: bmp.height, source: bmp };
  },
  encode(source, width, height, type, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);
    ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  },
};

/** Downscale to MAX_LONG_EDGE, re-encode webp (jpeg fallback) at 0.8, enforce the 2MB cap. */
export async function compressImage(file: Blob, io: ImageIO = browserImageIO): Promise<Blob> {
  let decoded;
  try {
    decoded = await io.decode(file);
  } catch {
    throw new ImageError("This image format isn't supported — try again or choose a JPEG/PNG.");
  }
  const { width, height } = fitWithin(decoded.width, decoded.height);
  let out = await io.encode(decoded.source, width, height, "image/webp", 0.8);
  if (!out || out.type !== "image/webp") {
    out = await io.encode(decoded.source, width, height, "image/jpeg", 0.8);
  }
  if (!out) throw new ImageError("This image format isn't supported — try again or choose a JPEG/PNG.");
  if (out.size > MAX_IMAGE_BYTES) throw new ImageError("Image too large even after compression");
  return out;
}

export interface StageResult {
  staged: StagedImage[];
  errors: string[];
}

/** Single door for picker, paste and drop. Keeps the first MAX_IMAGES. */
export async function stageImages(
  existing: StagedImage[],
  files: File[],
  io: ImageIO = browserImageIO,
  makeUrl: (b: Blob) => string = (b) => URL.createObjectURL(b),
): Promise<StageResult> {
  const staged = [...existing];
  const errors: string[] = [];
  for (const f of files) {
    if (staged.length >= MAX_IMAGES) {
      errors.push("Up to 3 screenshots per report");
      break;
    }
    try {
      const blob = await compressImage(f, io);
      staged.push({ id: newUUID(), blob, previewUrl: makeUrl(blob), name: f.name || "screenshot" });
    } catch (e) {
      errors.push(e instanceof ImageError ? e.message : "Could not attach this image");
    }
  }
  return { staged, errors };
}

/** Image files on a paste; text-only pastes yield nothing and must not be swallowed. */
export function imagesFromClipboard(data: Pick<DataTransfer, "items"> | null | undefined): File[] {
  const out: File[] = [];
  if (!data?.items) return out;
  for (const item of Array.from(data.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

export function loadDraft(storage: Pick<Storage, "getItem"> = localStorage): string {
  try {
    return storage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(text: string, storage: Pick<Storage, "setItem" | "removeItem"> = localStorage): void {
  try {
    if (text) storage.setItem(DRAFT_KEY, text);
    else storage.removeItem(DRAFT_KEY);
  } catch {
    /* private mode */
  }
}

export function descriptionValid(text: string): boolean {
  const n = text.trim().length;
  return n >= MIN_DESCRIPTION && n <= MAX_DESCRIPTION;
}

export type SubmitResult =
  | { ok: true; id: number; key: string }
  | { ok: false; message: string };

export interface SubmitInput {
  description: string;
  key: string;
  context: BugContext;
  images: Blob[];
}

/** POST the report; the stored draft is cleared only once the server answers 202. */
export async function submitReport(
  input: SubmitInput,
  deps: { fetch?: typeof fetch; storage?: Pick<Storage, "setItem" | "removeItem"> } = {},
): Promise<SubmitResult> {
  const doFetch = deps.fetch ?? fetch;
  const form = new FormData();
  form.set("description", input.description.trim());
  form.set("idempotency_key", input.key);
  form.set("context", JSON.stringify(input.context));
  input.images.forEach((b, i) => form.append("attachments", b, `screenshot-${i + 1}.${b.type === "image/webp" ? "webp" : "jpg"}`));
  let res: Response;
  try {
    res = await doFetch("/api/bug-report", { method: "POST", body: form });
  } catch {
    return { ok: false, message: "Could not reach the server. Your draft is kept — try again." };
  }
  if (res.status !== 202) {
    let msg = "Could not save the report. Your draft is kept.";
    try {
      const j = await res.json();
      if (typeof j?.error === "string") msg = j.error;
    } catch {
      /* non-JSON */
    }
    return { ok: false, message: msg };
  }
  let body: { id?: number; key?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* saved regardless */
  }
  saveDraft("", deps.storage);
  return { ok: true, id: Number(body.id ?? 0), key: body.key ?? input.key };
}

const ISSUE_URL = /^https:\/\/github\.com\/Josephkready\/kiwifs\/issues\/\d+$/;
export function safeIssueUrl(u: string | undefined): string | null {
  return u && ISSUE_URL.test(u) ? u : null;
}

export function statusLabel(s: SyncStatus): string {
  switch (s) {
    case "pending-sync":
      return "Saved, waiting to sync";
    case "queued":
      return "Saved, queued for GitHub";
    case "retry":
      return "Saved, GitHub is delayed";
    case "filed":
      return "Filed";
    case "failed":
    case "uncertain":
      return "Saved, needs attention";
  }
}

export const isFinalStatus = (s: SyncStatus) => s === "filed" || s === "failed";

export async function fetchRecent(
  opts: { path?: string | null; limit: number },
  doFetch: typeof fetch = fetch,
): Promise<PreviousReport[]> {
  const q = new URLSearchParams({ limit: String(opts.limit) });
  if (opts.path) q.set("path", opts.path);
  try {
    const res = await doFetch(`/api/bug-reports?${q}`);
    if (!res.ok) return [];
    return (await res.json()) as PreviousReport[];
  } catch {
    return [];
  }
}

export async function fetchConfig(doFetch: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await doFetch("/api/bug-report/config");
    if (!res.ok) return false;
    return (await res.json()).available === true;
  } catch {
    return false;
  }
}

/**
 * Poll one report's status until it is final or POLL_MAX_MS passes. A failed
 * poll never reports the saved report as lost; it just tries again.
 */
export function pollStatus(
  id: number,
  onUpdate: (s: { sync_status: SyncStatus; issue_url?: string }) => void,
  opts: { intervalMs?: number; maxMs?: number; fetch?: typeof fetch; now?: () => number } = {},
): () => void {
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;
  const max = opts.maxMs ?? POLL_MAX_MS;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const started = now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    let final = false;
    try {
      const res = await doFetch(`/api/bug-reports/${id}/status`);
      if (res.ok) {
        const j = await res.json();
        if (!stopped) onUpdate(j);
        final = isFinalStatus(j.sync_status);
      }
    } catch {
      /* keep polling */
    }
    if (stopped || final || now() - started >= max) return;
    timer = setTimeout(tick, interval);
  };
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export function selectionSnippet(sel: Pick<Selection, "toString"> | null | undefined): string {
  return (sel?.toString() ?? "").trim().slice(0, 500);
}
