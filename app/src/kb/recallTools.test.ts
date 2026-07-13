// SPEC-0026 ASK-4/5 — the read-only recall tool surface over a real on-disk graph.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { buildRecallVault, type RecallVault } from '../../test/recallVault';
import { rmTempDir, makeTempDir } from '../../test/tempVault';
import { makeReadOnlyTools, parseClaimMd } from './recallTools';
import { renderClaimMd } from './claimDoc';
import { renderEntityNode, type EntityNode } from './connectDoc';
import { ulid } from './ulid';
import type { RecallTools } from './recall';

describe('parseClaimMd — statement excludes the VAULT-13 source trailer (regression: #99×#102)', () => {
  it('reads the statement as the first body line, not the whole body with its Source: [[…]] citation', () => {
    const md = renderClaimMd(
      { statement: 'Ada Lovelace worked with Charles Babbage.', status: 'fact', confidence: 0.9, mentions: ['m'] },
      { id: '01C', subject: 'entities/person/ada.md', derivedFrom: 'sources/2026/06/02/01SRC', createdAt: '2026-06-02T00:00:00Z' },
    );
    expect(md).toContain('Source: [['); // the file DOES carry the clickable citation (VAULT-13)
    const parsed = parseClaimMd(md);
    expect(parsed.statement).toBe('Ada Lovelace worked with Charles Babbage.'); // …but the statement is clean
    expect(parsed.statement).not.toContain('Source:');
  });
});

describe('recall read-only tools (ASK-4/5)', () => {
  let v: RecallVault;
  let tools: RecallTools;
  beforeAll(async () => {
    v = await buildRecallVault();
    tools = makeReadOnlyTools(v.root);
  });
  afterAll(async () => {
    await rmTempDir(v.root);
  });

  it('entityLookup finds by name, alias, and filters by kind; surfaces tags (META)', async () => {
    const ada = await tools.entityLookup({ query: 'ada' });
    expect(ada.map((e) => e.rel)).toContain(v.adaRel);
    expect(ada.find((e) => e.rel === v.adaRel)?.tags).toContain('type/person');
    expect((await tools.entityLookup({ query: 'Lovelace' })).some((e) => e.name === 'Ada Lovelace')).toBe(true);
    expect((await tools.entityLookup({ query: '', kind: 'concept' })).map((e) => e.rel)).toEqual([v.engineRel]);
  });

  it('claimsForEntity matches by entity name or rel-path; unknown → none', async () => {
    const byName = await tools.claimsForEntity({ entity: 'Ada Lovelace' });
    expect(byName).toHaveLength(1);
    expect(byName[0].rel).toBe(v.claimRel);
    expect(byName[0].status).toBe('fact');
    expect(byName[0].subject).toBe(v.adaRel);
    expect(byName[0].mentions).toContain('first computer programmer');
    expect(await tools.claimsForEntity({ entity: v.adaRel })).toHaveLength(1);
    expect(await tools.claimsForEntity({ entity: 'Nobody' })).toEqual([]);
  });

  it('linkTraversal returns outgoing wikilinks and incoming backlinks', async () => {
    const { outgoing, incoming } = await tools.linkTraversal({ entity: 'Ada Lovelace' });
    expect(outgoing.map((l) => l.to)).toContain(v.engineRel);
    expect(incoming.some((l) => l.from === v.engineRel && l.to === v.adaRel)).toBe(true);
  });

  it('readNode reads entity/claim docs; refuses sources, missing, and out-of-bounds paths', async () => {
    expect(await tools.readNode({ rel: v.adaRel })).toContain('Ada Lovelace');
    expect(await tools.readNode({ rel: v.claimRel })).toContain('first computer programmer');
    expect(await tools.readNode({ rel: `${v.sourceDir}/source.md` })).toBeNull(); // sources only via readSource
    expect(await tools.readNode({ rel: '../../../etc/passwd' })).toBeNull(); // escape blocked
    expect(await tools.readNode({ rel: 'entities/person/missing.md' })).toBeNull();
  });

  it('readSource reads source.md ground truth (dir or explicit file); non-source → null', async () => {
    expect(await tools.readSource({ dir: v.sourceDir })).toContain('Analytical Engine');
    expect(await tools.readSource({ dir: `${v.sourceDir}/source.md` })).toContain('Analytical Engine');
    expect(await tools.readSource({ dir: 'sources/nope' })).toBeNull();
    expect(await tools.readSource({ dir: v.adaRel })).toBeNull(); // not under sources/
  });

  it('grep does a bounded, case-insensitive line search; empty pattern → nothing', async () => {
    const hits = await tools.grep({ pattern: 'analytical' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.text.toLowerCase().includes('analytical'))).toBe(true);
    expect(await tools.grep({ pattern: '' })).toEqual([]);
  });
});

// #513 — per-question memo: `makeReadOnlyTools` is built fresh per question (recall.ts), so every cache
// inside it is scoped to exactly one question's lifetime. These tests instrument node:fs directly so a
// regression (a cache that stops being hit) fails on the CLASS — a call count, not a specific code path.
describe('makeReadOnlyTools — per-question memo (#513)', () => {
  let v: RecallVault;
  beforeAll(async () => {
    v = await buildRecallVault();
  });
  afterAll(async () => {
    await rmTempDir(v.root);
  });

  it('one question performs ≤1 walk (readdir) each of entities/claims regardless of tool-call count', async () => {
    const tools = makeReadOnlyTools(v.root);
    const readdirSpy = vi.spyOn(fsp, 'readdir');
    // A scripted 10-call session mixing every tool that touches entities/claims.
    for (let i = 0; i < 3; i++) {
      await tools.entityLookup({ query: 'ada' });
      await tools.claimsForEntity({ entity: v.adaRel });
      await tools.linkTraversal({ entity: v.adaRel });
    }
    await tools.readNode({ rel: v.adaRel });
    const entitiesDirWalks = readdirSpy.mock.calls.filter((c) => String(c[0]).includes(`${path.sep}entities`)).length;
    const claimsDirWalks = readdirSpy.mock.calls.filter((c) => String(c[0]).includes(`${path.sep}claims`)).length;
    // `entities`/`claims` each have exactly one subdirectory in the fixture (person/concept), so one walk
    // of the directory tree issues one readdir per directory level visited — the invariant under test is
    // that REPEATING the 3-tool loop 3× does not multiply this, i.e. the walk itself is cached.
    expect(entitiesDirWalks).toBeGreaterThan(0);
    expect(claimsDirWalks).toBeGreaterThan(0);
    readdirSpy.mockClear();
    // A second identical loop must add ZERO further readdir calls — everything after the first walk is
    // served from the per-question cache.
    await tools.entityLookup({ query: 'ada' });
    await tools.claimsForEntity({ entity: v.adaRel });
    await tools.linkTraversal({ entity: v.adaRel });
    expect(readdirSpy).not.toHaveBeenCalled();
    readdirSpy.mockRestore();
  });

  it('a file read once (by entityLookup) is never re-read by readNode hitting the same path', async () => {
    const tools = makeReadOnlyTools(v.root);
    const readFileSpy = vi.spyOn(fsp, 'readFile');
    await tools.entityLookup({ query: 'ada' }); // reads ada's node to parse it
    const afterLookup = readFileSpy.mock.calls.filter((c) => String(c[0]).endsWith('ada-lovelace.md')).length;
    expect(afterLookup).toBeGreaterThan(0);
    await tools.readNode({ rel: v.adaRel }); // same file — must be a cache hit, not a fresh read
    const afterReadNode = readFileSpy.mock.calls.filter((c) => String(c[0]).endsWith('ada-lovelace.md')).length;
    expect(afterReadNode).toBe(afterLookup);
    readFileSpy.mockRestore();
  });

  it('grep is served from its own once-read cache — a second grep call re-reads nothing', async () => {
    const tools = makeReadOnlyTools(v.root);
    await tools.grep({ pattern: 'analytical' });
    const readFileSpy = vi.spyOn(fsp, 'readFile');
    await tools.grep({ pattern: 'engine' });
    expect(readFileSpy).not.toHaveBeenCalled();
    readFileSpy.mockRestore();
  });

  it('results are byte-identical to a fresh (unmemoized-equivalent) tools instance on the same vault', async () => {
    const a = makeReadOnlyTools(v.root);
    const b = makeReadOnlyTools(v.root); // a second, independent instance — its own fresh caches
    const [la, lb] = await Promise.all([a.linkTraversal({ entity: v.adaRel }), b.linkTraversal({ entity: v.adaRel })]);
    expect(la).toEqual(lb);
    const [ca, cb] = await Promise.all([a.claimsForEntity({ entity: v.adaRel }), b.claimsForEntity({ entity: v.adaRel })]);
    expect(ca).toEqual(cb);
  });
});

// #513 — deterministic, confidence-ranked entity resolution (was: `.find()`, the first substring hit in
// fs-walk order — silently wrong-entity on an ambiguous name). A directory-order-shuffled fixture: three
// entities whose names all substring-match one needle, deliberately filed so alphabetical/creation order
// would pick the WRONG one if resolution still depended on walk order.
describe('entity resolution — deterministic + confidence-ranked (#513)', () => {
  let root: string;
  let loRel: string; // "Lo Peep" — low confidence, substring-matches "lo", NOT an exact match
  let hiRel: string; // "Loud" — HIGH confidence, substring-matches "lo" — must win the ambiguous case
  let longRel: string; // "Lounge Chair" — same confidence as `loRel`, longer name — tiebreak loser
  const claimForLoRel = 'claims/a/lo.md';
  const claimForHiRel = 'claims/z/loud.md';

  async function writeEntity(root: string, rel: string, name: string, confidence: number): Promise<void> {
    const node: EntityNode = {
      id: ulid(),
      kind: 'concept',
      name,
      confidence,
      aliases: [],
      tags: [],
      derivedFrom: [],
      resolvedFrom: [],
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    };
    await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fsp.writeFile(path.join(root, rel), renderEntityNode(node));
  }

  beforeAll(async () => {
    root = await makeTempDir('kb-recall-ambig-');
    // Deliberately named so alpha/creation order (a, z) does NOT match confidence order — "z-loud" is
    // filed AFTER "a-lo" so a naive `.find()` over fs-walk order would pick "Lo" (wrong), not "Loud".
    loRel = 'entities/a/a-lo.md';
    hiRel = 'entities/z/z-loud.md';
    longRel = 'entities/m/m-lounge.md';
    await writeEntity(root, loRel, 'Lo Peep', 0.3);
    await writeEntity(root, hiRel, 'Loud', 0.9);
    await writeEntity(root, longRel, 'Lounge Chair', 0.3); // same confidence as `loRel`, longer name

    for (const [rel, subject] of [
      [claimForLoRel, loRel],
      [claimForHiRel, hiRel],
    ] as const) {
      const claimMd = renderClaimMd(
        { statement: `A claim about ${subject}.`, status: 'fact', confidence: 0.5, mentions: ['x'] },
        { id: ulid(), subject, derivedFrom: 'sources/none', createdAt: '2026-07-13T00:00:00.000Z' },
      );
      await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fsp.writeFile(path.join(root, rel), claimMd);
    }
  });
  afterAll(async () => {
    await rmTempDir(root);
  });

  it('picks the HIGHEST-confidence substring match, not the first one in fs-walk order', async () => {
    // "lo" is a pure substring of all three ("Lo Peep", "Loud", "Lounge Chair") — none is an exact name
    // match, so resolution is ambiguous; claimsForEntity surfaces claims across the top-ranked candidates
    // instead of silently guessing the fs-walk-order winner — the HIGH-confidence "Loud" claim must appear.
    const tools = makeReadOnlyTools(root);
    const claims = await tools.claimsForEntity({ entity: 'lo' });
    expect(claims.some((c) => c.subject === hiRel)).toBe(true);
  });

  it('is deterministic across repeated calls / fresh instances (order-independent)', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => makeReadOnlyTools(root)).map((t) => t.claimsForEntity({ entity: 'lo' })),
    );
    const shapes = results.map((r) => JSON.stringify(r.map((c) => c.subject).sort()));
    expect(new Set(shapes).size).toBe(1); // every independent call agrees on the same resolved set
  });

  it('an EXACT name match always wins over any substring candidate, ambiguous or not', async () => {
    const tools = makeReadOnlyTools(root);
    const claims = await tools.claimsForEntity({ entity: 'Loud' }); // exact name match — unambiguous
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.subject === hiRel)).toBe(true); // never blended with the other candidates
  });
});
