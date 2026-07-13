// The read-only KB tool surface the recall agent navigates (SPEC-0026 ASK-4/5). Every method
// READS the evergreen graph (sources/entities/claims); none mutates it — so ASK-3 (read-only
// w.r.t. the ontology) holds by construction: there is simply no write path here.
//
// Tools wrap the on-disk layout directly (lightweight — `parseEntityNode` from connectDoc + a
// tolerant claim parser), so recall does not depend on the autonomous stage machinery. Tag/
// property filters (SPEC-0025 META) and the Obsidian CLI accelerator (ASK-9) are intentionally
// NOT registered yet — capability-gated until those land; they slot in without changing the loop.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseEntityNode } from './connectDoc';
import { resolveContainedRel } from './pathContainment';
import type { RecallTools, EntityHit, ClaimHit, LinkHit, GrepHit } from './recall';

const DEFAULT_ENTITY_LIMIT = 10;
const DEFAULT_CLAIM_LIMIT = 50;
const DEFAULT_GREP_LIMIT = 50;
const GREP_EXTS = new Set(['.md', '.txt']);
// Bound on how many ambiguous-match alternatives claimsForEntity surfaces (#513) — enough to show the
// model a real ambiguity without flooding a loosely-typed name into dozens of unrelated claims.
const MAX_AMBIGUOUS_CANDIDATES = 3;

// Path containment for the LLM-/index-supplied `rel`s these read tools resolve now lives in the
// shared, symlink-safe helper (SPEC-0030 / #30): `resolveContainedRel` returns the abs path or null
// (skip) — reads never throw. It hardens the old lexical `safeResolve` against committed-symlink
// escapes too (a symlinked vault file could otherwise surface host content as "cited KB content").

/** Recursively collect files under `dir` (repo-relative to `root`) matching `keep`. */
async function walkFiles(root: string, dir: string, keep: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) await rec(full);
      else if (e.isFile() && keep(e.name)) out.push(path.relative(root, full));
    }
  }
  await rec(path.join(root, dir));
  return out;
}

// ── A tolerant claim-file parser (claimDoc.ts only renders; recall needs to read) ───────────

export interface ParsedClaim {
  id: string;
  subject: string; // repo-relative path to the subject entity node
  status: string;
  confidence: number;
  derivedFrom: string[];
  mentions: string[];
  relatesTo: string[];
  statement: string; // body (one line)
}

function fmScalar(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t;
    }
  }
  return t;
}

function fmSeq(raw: string): string[] {
  try {
    const arr = JSON.parse(raw.trim()) as unknown[];
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/** Parse a claim `.md` (frontmatter + one-line statement body). Throws on a non-claim doc. */
export function parseClaimMd(md: string): ParsedClaim {
  const fmEnd = md.indexOf('\n---', 3);
  const fm = fmEnd === -1 ? md : md.slice(0, fmEnd);
  const body = fmEnd === -1 ? '' : md.slice(fmEnd + 4);
  let id = '';
  let subject = '';
  let status = '';
  let confidence = 0;
  let derivedFrom: string[] = [];
  let mentions: string[] = [];
  let relatesTo: string[] = [];
  for (const line of fm.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^id:\s*(.+)$/))) id = fmScalar(m[1]);
    else if ((m = line.match(/^subject:\s*(.+)$/))) subject = fmScalar(m[1]);
    else if ((m = line.match(/^status:\s*(.+)$/))) status = fmScalar(m[1]);
    else if ((m = line.match(/^confidence:\s*(.+)$/))) confidence = Number(m[1].trim()) || 0;
    else if ((m = line.match(/^\s+derivedFrom:\s*(\[.*\])\s*$/))) derivedFrom = fmSeq(m[1]);
    else if ((m = line.match(/^\s+mentions:\s*(\[.*\])\s*$/))) mentions = fmSeq(m[1]);
    else if ((m = line.match(/^relatesTo:\s*(\[.*\])\s*$/))) relatesTo = fmSeq(m[1]);
  }
  if (!id || !subject) throw new Error('recall: claim file missing id/subject');
  // The statement is the claim's FIRST line. A claim file's body may carry a trailing
  // "Source: [[…]]" citation (VAULT-13) which is provenance, NOT part of the assertion — so the
  // whole-body string is no longer the statement. (Statements are always single-line `oneLine`.)
  const statement = body.trim().split('\n', 1)[0]?.trim() ?? '';
  return { id, subject, status, confidence, derivedFrom, mentions, relatesTo, statement };
}

/** Extract `[[target]]` wikilink targets from a node body. */
function extractWikilinks(md: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[1].trim());
  return out;
}

// ── The tool surface ────────────────────────────────────────────────────────────────────────

/** Build the read-only recall tool surface over a vault `root` (the evergreen checkout). Per-question
 *  lazy memo (#513 PERF-A2/A7/A9): `recall()` builds a fresh instance per question, so every cache below
 *  is scoped to exactly that question's 4-24 tool calls — the vault is the settled canonical tree and a
 *  question is seconds long, so staleness is acceptable by construction. Without this, every call re-walked
 *  the vault (tens of thousands of file reads / ~100k+ syscalls per Considered question). */
export function makeReadOnlyTools(root: string): RecallTools {
  root = path.resolve(root);

  // A single read cache shared by every path below (keyed by resolved abs path) — a file read once (by
  // allEntities, the backlink walk, or grep) is never re-read by readNode/readSource hitting the same path.
  const readCache = new Map<string, Promise<string | null>>();
  function cachedRead(p: string): Promise<string | null> {
    let hit = readCache.get(p);
    if (!hit) {
      hit = fs.readFile(p, 'utf8').catch((): null => null);
      readCache.set(p, hit);
    }
    return hit;
  }

  let entitiesPromise: Promise<EntityHit[]> | null = null;
  function allEntities(): Promise<EntityHit[]> {
    return (entitiesPromise ??= (async () => {
      const rels = await walkFiles(root, 'entities', (n) => n.endsWith('.md'));
      const hits: EntityHit[] = [];
      for (const rel of rels) {
        try {
          const p = await resolveContainedRel(root, rel);
          if (!p) continue;
          const md = await cachedRead(p);
          if (md == null) continue;
          const node = parseEntityNode(md);
          hits.push({
            rel,
            id: node.id,
            kind: node.kind,
            name: node.name,
            aliases: node.aliases,
            confidence: node.confidence,
            tags: node.tags,
            derivedFrom: node.derivedFrom,
          });
        } catch {
          /* foreign / malformed node — skip */
        }
      }
      return hits;
    })());
  }

  let claimsPromise: Promise<Array<ParsedClaim & { rel: string }>> | null = null;
  function allClaims(): Promise<Array<ParsedClaim & { rel: string }>> {
    return (claimsPromise ??= (async () => {
      const rels = await walkFiles(root, 'claims', (n) => n.endsWith('.md'));
      const out: Array<ParsedClaim & { rel: string }> = [];
      for (const rel of rels) {
        try {
          const p = await resolveContainedRel(root, rel);
          if (!p) continue;
          const md = await cachedRead(p);
          if (md == null) continue;
          out.push({ ...parseClaimMd(md), rel });
        } catch {
          /* malformed claim — skip */
        }
      }
      return out;
    })());
  }

  // The backlink SOURCE SET: every raw entities/+claims/ `.md` file (incl. ones that fail to parse as a
  // valid entity/claim — the live walk always counted those as potential backlink carriers, so the cache
  // must too). Built once, lazily, on the FIRST linkTraversal call — a question that never calls it never
  // pays for it.
  let graphFilesPromise: Promise<Array<{ rel: string; md: string }>> | null = null;
  function graphFiles(): Promise<Array<{ rel: string; md: string }>> {
    return (graphFilesPromise ??= (async () => {
      const rels = [
        ...(await walkFiles(root, 'entities', (n) => n.endsWith('.md'))),
        ...(await walkFiles(root, 'claims', (n) => n.endsWith('.md'))),
      ];
      const out: Array<{ rel: string; md: string }> = [];
      for (const rel of rels) {
        const p = await resolveContainedRel(root, rel);
        if (!p) continue;
        const md = await cachedRead(p);
        if (md != null) out.push({ rel, md });
      }
      return out;
    })());
  }

  // The inverted backlink index — literal `[[target]]` text → the files that carry it — built once from
  // `graphFiles()` on first traversal, so every subsequent linkTraversal call is an O(1) map lookup instead
  // of an O(N) re-scan. Matches the live semantics exactly: a wikilink target is matched as WRITTEN (the
  // same effect as the old `.includes('[[<rel>]]')` substring test, since a target is bounded by `[[`/`]]`).
  let backlinkMapPromise: Promise<Map<string, LinkHit[]>> | null = null;
  function backlinkMap(): Promise<Map<string, LinkHit[]>> {
    return (backlinkMapPromise ??= (async () => {
      const files = await graphFiles();
      const map = new Map<string, LinkHit[]>();
      for (const f of files) {
        for (const to of extractWikilinks(f.md)) {
          const list = map.get(to);
          const hit: LinkHit = { from: f.rel, to };
          if (list) list.push(hit);
          else map.set(to, [hit]);
        }
      }
      return map;
    })());
  }

  // grep's own once-read text cache — a different candidate set than allEntities/allClaims (it also
  // includes sources/ and .txt files), so it keeps its own walk, but that walk (and every file it reads)
  // happens at most once regardless of how many grep calls one question makes.
  let grepFilesPromise: Promise<Array<{ rel: string; text: string }>> | null = null;
  function grepFiles(): Promise<Array<{ rel: string; text: string }>> {
    return (grepFilesPromise ??= (async () => {
      const rels = [
        ...(await walkFiles(root, 'sources', (n) => GREP_EXTS.has(path.extname(n)))),
        ...(await walkFiles(root, 'entities', (n) => GREP_EXTS.has(path.extname(n)))),
        ...(await walkFiles(root, 'claims', (n) => GREP_EXTS.has(path.extname(n)))),
      ];
      const out: Array<{ rel: string; text: string }> = [];
      for (const rel of rels) {
        const p = await resolveContainedRel(root, rel);
        if (!p) continue;
        const text = await cachedRead(p);
        if (text != null) out.push({ rel, text });
      }
      return out;
    })());
  }

  /** Rank substring candidates DETERMINISTICALLY — confidence desc, then shortest name (tie-break), then
   *  name asc — so the match never depends on filesystem walk order (#513: was `.find`, the first hit in
   *  fs-walk order, which silently picked the wrong entity on a directory-order shuffle). */
  function rankSubstringMatches(ents: EntityHit[], needle: string): EntityHit[] {
    return ents
      .filter((e) => e.name.toLowerCase().includes(needle))
      .sort((a, b) => b.confidence - a.confidence || a.name.length - b.name.length || a.name.localeCompare(b.name));
  }

  /** Resolve an entity reference (rel path OR name/alias) to its node rel-path. `ambiguous` is true when
   *  more than one entity substring-matches with no exact name/alias hit — `candidates` then carries the
   *  top-ranked alternatives (bounded) so a caller can surface them instead of silently guessing wrong. */
  async function resolveEntity(entity: string): Promise<{ rel: string | null; ambiguous: boolean; candidates: EntityHit[] }> {
    if (typeof entity !== 'string' || entity.length === 0) return { rel: null, ambiguous: false, candidates: [] };
    const direct = await resolveContainedRel(root, entity);
    if (direct && entity.includes('/') && entity.endsWith('.md')) {
      try {
        await fs.access(direct);
        return { rel: entity, ambiguous: false, candidates: [] };
      } catch {
        /* fall through to name match */
      }
    }
    const needle = entity.toLowerCase();
    const ents = await allEntities();
    const exact = ents.find((e) => e.name.toLowerCase() === needle || e.aliases.some((a) => a.toLowerCase() === needle));
    if (exact) return { rel: exact.rel, ambiguous: false, candidates: [] };
    const ranked = rankSubstringMatches(ents, needle);
    if (ranked.length === 0) return { rel: null, ambiguous: false, candidates: [] };
    return { rel: ranked[0].rel, ambiguous: ranked.length > 1, candidates: ranked.slice(0, MAX_AMBIGUOUS_CANDIDATES) };
  }

  /** Back-compat single-value resolution (linkTraversal: a link graph can't cleanly merge candidates, so
   *  it always resolves to the single top-ranked — still deterministic, just not alternatives-surfacing). */
  async function resolveEntityRel(entity: string): Promise<string | null> {
    return (await resolveEntity(entity)).rel;
  }

  return {
    async entityLookup({ query, kind, limit }): Promise<EntityHit[]> {
      const needle = (query ?? '').toLowerCase();
      const ents = await allEntities();
      return ents
        .filter((e) => (!kind || e.kind.toLowerCase() === kind.toLowerCase()))
        .filter(
          (e) =>
            needle.length === 0 ||
            e.name.toLowerCase().includes(needle) ||
            e.aliases.some((a) => a.toLowerCase().includes(needle)),
        )
        .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
        .slice(0, limit ?? DEFAULT_ENTITY_LIMIT);
    },

    async claimsForEntity({ entity, limit }): Promise<ClaimHit[]> {
      const { rel, ambiguous, candidates } = await resolveEntity(entity);
      if (!rel) return [];
      const claims = await allClaims();
      // #513: an ambiguous name (multiple substring matches, no exact hit) no longer silently guesses the
      // fs-walk-order winner — it returns claims across every top-ranked candidate's subject, so distinct
      // `subject` rels in the result surface the ambiguity to the model instead of masking it.
      const subjects = ambiguous ? new Set(candidates.map((c) => c.rel)) : new Set([rel]);
      return claims
        .filter((c) => subjects.has(c.subject))
        .slice(0, limit ?? DEFAULT_CLAIM_LIMIT)
        .map((c) => ({
          rel: c.rel,
          id: c.id,
          subject: c.subject,
          status: c.status,
          confidence: c.confidence,
          statement: c.statement,
          derivedFrom: c.derivedFrom,
          mentions: c.mentions,
          relatesTo: c.relatesTo,
        }));
    },

    async linkTraversal({ entity }): Promise<{ outgoing: LinkHit[]; incoming: LinkHit[] }> {
      const rel = await resolveEntityRel(entity);
      if (!rel) return { outgoing: [], incoming: [] };
      const outgoing: LinkHit[] = [];
      const p = await resolveContainedRel(root, rel);
      if (p) {
        const md = await cachedRead(p);
        if (md != null) for (const to of extractWikilinks(md)) outgoing.push({ from: rel, to });
      }
      // Incoming: the precomputed backlink index (built once per question, on first traversal) — an O(1)
      // lookup instead of an O(N) re-walk of every entities/+claims/ file per call.
      const incoming = (await backlinkMap()).get(rel)?.filter((l) => l.from !== rel) ?? [];
      return { outgoing, incoming };
    },

    async readNode({ rel }): Promise<string | null> {
      const p = await resolveContainedRel(root, rel);
      if (!p) return null;
      const r = typeof rel === 'string' ? rel : '';
      if (!(r.startsWith('entities/') || r.startsWith('entities' + path.sep) || r.startsWith('claims/') || r.startsWith('claims' + path.sep))) {
        return null; // read-only surface: only entity/claim docs via readNode
      }
      return cachedRead(p);
    },

    async readSource({ dir }): Promise<string | null> {
      if (typeof dir !== 'string' || dir.length === 0) return null;
      const rel = dir.endsWith('source.md') ? dir : path.join(dir, 'source.md');
      const p = await resolveContainedRel(root, rel);
      if (!p) return null;
      const r = path.relative(root, p);
      if (!(r === 'sources' || r.startsWith('sources/') || r.startsWith('sources' + path.sep))) return null;
      return cachedRead(p);
    },

    async grep({ pattern, limit }): Promise<GrepHit[]> {
      const needle = (pattern ?? '').toLowerCase();
      if (needle.length === 0) return [];
      const cap = limit ?? DEFAULT_GREP_LIMIT;
      const hits: GrepHit[] = [];
      for (const { rel, text } of await grepFiles()) {
        if (hits.length >= cap) break;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < cap; i++) {
          if (lines[i].toLowerCase().includes(needle)) hits.push({ rel, line: i + 1, text: lines[i].trim() });
        }
      }
      return hits;
    },
  };
}
