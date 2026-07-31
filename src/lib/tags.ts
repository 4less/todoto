import type { Tag, Todo, Note, Whiteboard } from './types';

// Canonical tags.
//
// Two layers, deliberately separate:
//
//   1. Automatic — case and separators carry no meaning, so "ProtalDev",
//      "protal_dev" and "PROTAL-DEV" all reduce to the same key and are the
//      same tag. Nothing to curate; the registry only decides which spelling
//      is *displayed*.
//
//   2. Manual — spellings that don't reduce to the same key ("k8s" vs
//      "kubernetes", "portal-dev" vs "protal-dev") are only unified when the
//      user says so, by recording an alias. Nothing here ever merges tags on
//      similarity alone; near-misses are surfaced as warnings, never applied.

/** Identity of a tag: what makes two spellings trivially the same. */
export function tagKey(raw: string): string {
  return raw
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
    .replace(/[\s_\-.]+/g, '');
}

/** Strips decoration without touching case — the spelling as the user typed it. */
export function cleanTag(raw: string): string {
  return raw.trim().replace(/^#/, '').replace(/\s+/g, ' ');
}

/** Every key that resolves to a given tag: its canonical form plus its aliases. */
export function keysOf(tag: Tag): string[] {
  return [tagKey(tag.canonical), ...tag.aliases.map(tagKey)];
}

/** The registry entry a spelling belongs to, or null if it's not curated yet. */
export function findTag(raw: string, registry: Tag[]): Tag | null {
  const key = tagKey(raw);
  if (!key) return null;
  return registry.find((t) => keysOf(t).includes(key)) ?? null;
}

/**
 * The spelling that should actually be stored on an item. Resolves through the
 * registry when the tag is known; otherwise returns the input cleaned up, which
 * is how a brand-new tag enters the system.
 */
export function canonicalize(raw: string, registry: Tag[]): string {
  return findTag(raw, registry)?.canonical ?? cleanTag(raw);
}

/** Canonicalizes a list, dropping blanks and duplicates that collapse together. */
export function canonicalizeAll(raws: string[], registry: Tag[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    const tag = canonicalize(raw, registry);
    const key = tagKey(tag);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** Splits a typed string like "#foo, bar baz" into individual tag spellings. */
export function splitTagInput(raw: string): string[] {
  return raw.split(/[,]+/).flatMap((part) => part.trim().split(/\s+/)).map(cleanTag).filter(Boolean);
}

// ── Usage ────────────────────────────────────────────────────────────────────

export interface TagUsage {
  /** Canonical (or as-stored) spelling → how many items carry it. */
  counts: Map<string, number>;
  todos: Map<string, number>;
  notes: Map<string, number>;
  boards: Map<string, number>;
}

function tally(into: Map<string, number>, all: Map<string, number>, tags: string[]) {
  for (const raw of tags) {
    const key = tagKey(raw);
    if (!key) continue;
    into.set(key, (into.get(key) ?? 0) + 1);
    all.set(key, (all.get(key) ?? 0) + 1);
  }
}

/** Counts tag usage across every item kind, keyed by tagKey. */
export function tagUsage(todos: Todo[], notes: Note[], boards: Whiteboard[]): TagUsage {
  const counts = new Map<string, number>();
  const t = new Map<string, number>();
  const n = new Map<string, number>();
  const b = new Map<string, number>();
  for (const item of todos) tally(t, counts, item.tags);
  for (const item of notes) tally(n, counts, item.tags);
  for (const item of boards) tally(b, counts, item.tags);
  return { counts, todos: t, notes: n, boards: b };
}

/**
 * Every tag the app knows about: curated entries plus any spelling still only
 * present on items. Keeps uncurated tags visible so they can be merged.
 */
export function allTags(registry: Tag[], todos: Todo[], notes: Note[], boards: Whiteboard[]): Tag[] {
  const out = [...registry];
  const known = new Set(out.flatMap(keysOf));
  for (const item of [...todos, ...notes, ...boards]) {
    for (const raw of item.tags) {
      const key = tagKey(raw);
      if (!key || known.has(key)) continue;
      known.add(key);
      // Not curated yet, so it stands alone under the spelling found on the item.
      out.push({ id: `uncurated:${key}`, canonical: cleanTag(raw), aliases: [] });
    }
  }
  return out.sort((a, b) => a.canonical.localeCompare(b.canonical));
}

/**
 * The distinct spellings actually stored on items for a given tag. More than one
 * means older items still carry a variant: they're the same tag conceptually,
 * but code that compares raw strings (filters, project scoping, grouping) would
 * treat them as different until they're unified.
 */
export function storedVariants(
  tag: Tag,
  todos: Todo[],
  notes: Note[],
  boards: Whiteboard[]
): string[] {
  const keys = new Set(keysOf(tag));
  const seen = new Map<string, string>();
  for (const item of [...todos, ...notes, ...boards]) {
    for (const raw of item.tags) {
      const k = tagKey(raw);
      if (keys.has(k) && !seen.has(raw)) seen.set(raw, raw);
    }
  }
  return [...seen.values()];
}

/** True for entries synthesised by allTags() rather than stored in the registry. */
export function isUncurated(tag: Tag): boolean {
  return tag.id.startsWith('uncurated:');
}

// ── Near-miss detection (suggestion only — never applied automatically) ──────

/** Levenshtein distance, capped: we only care about "close enough to warn". */
function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
    if (Math.min(...curr) > max) return max + 1;
  }
  return prev[b.length];
}

/** How close two keys are, as a tolerance that scales with length. */
function tolerance(key: string): number {
  if (key.length <= 4) return 1;
  if (key.length <= 8) return 2;
  return 3;
}

/**
 * Existing tags close enough to `raw` that creating it might be a mistake —
 * shown next to the "create new tag" affordance so near-duplicates get noticed
 * at the moment they'd be introduced. Never merges anything on its own.
 */
export function similarTags(raw: string, candidates: Tag[]): Tag[] {
  const key = tagKey(raw);
  if (key.length < 3) return [];
  const scored: Array<{ tag: Tag; d: number }> = [];
  for (const tag of candidates) {
    for (const k of keysOf(tag)) {
      if (k === key) return []; // exact match: not a new tag at all
      const d = editDistance(key, k, tolerance(key));
      // A containment relationship counts as close ("proj" vs "project").
      const contained = k.includes(key) || key.includes(k);
      if (d <= tolerance(key) || contained) {
        scored.push({ tag, d: contained ? Math.min(d, 1) : d });
        break;
      }
    }
  }
  return scored.sort((a, b) => a.d - b.d).slice(0, 3).map((s) => s.tag);
}

/** Groups of curated tags that look like they should probably be merged. */
export function duplicateCandidates(tags: Tag[]): Array<[Tag, Tag]> {
  const pairs: Array<[Tag, Tag]> = [];
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      if (similarTags(tags[i].canonical, [tags[j]]).length > 0) pairs.push([tags[i], tags[j]]);
    }
  }
  return pairs;
}
