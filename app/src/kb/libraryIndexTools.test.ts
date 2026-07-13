// Library index — equivalence + zero-fs-reads proof (SPEC-0061 T1, #530 slice 1 AC). Same template as
// `graphProjection.test.ts`'s STATE-2 proof: build a real seeded vault, serve the SAME `RecallTools`
// contract from both the live walker and the index, and assert byte-identical output. `grep`'s scan
// order is index-sorted (documented as a strict improvement over the live walker's unspecified
// `readdir` order in `libraryIndexTools.ts`) so grep results are compared SET-wise, not order-wise;
// every other tool is compared with `toEqual` (order IS part of the live contract there — confidence/
// name sort for `entityLookup`, insertion order elsewhere — and the index ports that sort verbatim).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildRecallVault, type RecallVault } from '../../test/recallVault';
import { rmTempDir } from '../../test/tempVault';
import { makeReadOnlyTools } from './recallTools';
import { makeFakeLibraryIndexStore } from './libraryIndexFake';
import { rebuildLibraryIndexFull } from './libraryIndexBuild';
import { makeIndexTools, sanitizeFtsQuery } from './libraryIndexTools';
import { buildHealthReport } from './healthPanel';

async function buildIndexTools(root: string) {
  const store = makeFakeLibraryIndexStore();
  await rebuildLibraryIndexFull(store, root, 'HEAD1');
  return makeIndexTools(store);
}

describe('library index — index-backed reads equal the live vault walk', () => {
  let v: RecallVault;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
  });

  it('entityLookup — identical results (no query, and a substring query)', async () => {
    v = await buildRecallVault();
    const live = makeReadOnlyTools(v.root);
    const idx = await buildIndexTools(v.root);
    expect(await idx.entityLookup({ query: '' })).toEqual(await live.entityLookup({ query: '' }));
    expect(await idx.entityLookup({ query: 'ada' })).toEqual(await live.entityLookup({ query: 'ada' }));
    expect(await idx.entityLookup({ query: '', kind: 'concept' })).toEqual(await live.entityLookup({ query: '', kind: 'concept' }));
  });

  it('claimsForEntity — resolves by rel and by name, identical claim list', async () => {
    v = await buildRecallVault();
    const live = makeReadOnlyTools(v.root);
    const idx = await buildIndexTools(v.root);
    expect(await idx.claimsForEntity({ entity: v.adaRel })).toEqual(await live.claimsForEntity({ entity: v.adaRel }));
    expect(await idx.claimsForEntity({ entity: 'Ada Lovelace' })).toEqual(await live.claimsForEntity({ entity: 'Ada Lovelace' }));
    expect(await idx.claimsForEntity({ entity: 'nonexistent' })).toEqual(await live.claimsForEntity({ entity: 'nonexistent' }));
  });

  it('linkTraversal — identical outgoing + incoming from both sides', async () => {
    v = await buildRecallVault();
    const live = makeReadOnlyTools(v.root);
    const idx = await buildIndexTools(v.root);
    expect(await idx.linkTraversal({ entity: v.adaRel })).toEqual(await live.linkTraversal({ entity: v.adaRel }));
    expect(await idx.linkTraversal({ entity: v.engineRel })).toEqual(await live.linkTraversal({ entity: v.engineRel }));
    expect(await idx.linkTraversal({ entity: 'nonexistent' })).toEqual(await live.linkTraversal({ entity: 'nonexistent' }));
  });

  it('readNode — identical raw markdown for entity + claim docs, null outside the surface', async () => {
    v = await buildRecallVault();
    const live = makeReadOnlyTools(v.root);
    const idx = await buildIndexTools(v.root);
    expect(await idx.readNode({ rel: v.adaRel })).toEqual(await live.readNode({ rel: v.adaRel }));
    expect(await idx.readNode({ rel: v.claimRel })).toEqual(await live.readNode({ rel: v.claimRel }));
    expect(await idx.readNode({ rel: 'sources/whatever' })).toEqual(await live.readNode({ rel: 'sources/whatever' }));
  });

  it('readSource — identical source.md text, with/without the trailing filename', async () => {
    v = await buildRecallVault();
    const live = makeReadOnlyTools(v.root);
    const idx = await buildIndexTools(v.root);
    expect(await idx.readSource({ dir: v.sourceDir })).toEqual(await live.readSource({ dir: v.sourceDir }));
    expect(await idx.readSource({ dir: path.join(v.sourceDir, 'source.md') })).toEqual(await live.readSource({ dir: path.join(v.sourceDir, 'source.md') }));
    expect(await idx.readSource({ dir: 'entities/escape' })).toEqual(await live.readSource({ dir: 'entities/escape' }));
  });

  it('grep — identical hit SET (rel/line/text) for a substring present in source + entity + claim bodies', async () => {
    v = await buildRecallVault();
    const live = makeReadOnlyTools(v.root);
    const idx = await buildIndexTools(v.root);
    const key = (h: { rel: string; line: number; text: string }) => `${h.rel}:${h.line}:${h.text}`;
    const liveHits = (await live.grep({ pattern: 'programmer' })).map(key).sort();
    const idxHits = (await idx.grep({ pattern: 'programmer' })).map(key).sort();
    expect(idxHits).toEqual(liveHits);
    expect(idxHits.length).toBeGreaterThan(0); // sanity — the fixture really contains the needle
  });

  it('grep — empty pattern returns [] on both', async () => {
    v = await buildRecallVault();
    const live = makeReadOnlyTools(v.root);
    const idx = await buildIndexTools(v.root);
    expect(await idx.grep({ pattern: '' })).toEqual(await live.grep({ pattern: '' }));
  });

  it('buildHealthReport — identical structural scan through the index tool surface', async () => {
    v = await buildRecallVault();
    const live = makeReadOnlyTools(v.root);
    const idx = await buildIndexTools(v.root);
    expect(await buildHealthReport(idx)).toEqual(await buildHealthReport(live));
  });
});

describe('library index — malformed/orphan straggler fidelity (mirrors the graph-projection #468 fast-follow)', () => {
  it('linkTraversal.incoming counts a malformed entity + an orphan claim as backlink sources, same as live', async () => {
    const v = await buildRecallVault();
    try {
      await fs.mkdir(path.join(v.root, 'entities', 'concept'), { recursive: true });
      await fs.writeFile(
        path.join(v.root, 'entities', 'concept', 'broken.md'),
        'garbage, no frontmatter — but mentions [[entities/concept/analytical-engine.md]]\n',
        'utf8',
      );
      await fs.mkdir(path.join(v.root, 'claims', 'ghost'), { recursive: true });
      await fs.writeFile(
        path.join(v.root, 'claims', 'ghost', 'orphan.md'),
        '---\nid: 01ORPHAN\nsubject: entities/ghost/merged-away.md\nstatus: fact\nconfidence: 0.5\n---\nA fact mentioning [[entities/concept/analytical-engine.md]].\n',
        'utf8',
      );
      const live = makeReadOnlyTools(v.root);
      const idx = await buildIndexTools(v.root);
      const liveIn = (await live.linkTraversal({ entity: v.engineRel })).incoming.map((l) => l.from).sort();
      const idxIn = (await idx.linkTraversal({ entity: v.engineRel })).incoming.map((l) => l.from).sort();
      expect(idxIn).toEqual(liveIn);
      expect(liveIn).toContain(path.join('entities', 'concept', 'broken.md'));
      expect(liveIn).toContain(path.join('claims', 'ghost', 'orphan.md'));
    } finally {
      await rmTempDir(v.root);
    }
  });
});

describe('library index — search() composite ranked search (#538)', () => {
  it('sanitizeFtsQuery token-quotes input, neutralizing FTS5 syntax characters', () => {
    expect(sanitizeFtsQuery('hello world')).toBe('"hello" "world"');
    expect(sanitizeFtsQuery('  spaced   out  ')).toBe('"spaced" "out"');
    expect(sanitizeFtsQuery('a"b')).toBe('"a""b"');
    expect(sanitizeFtsQuery('AND OR NOT -foo *bar NEAR')).toBe('"AND" "OR" "NOT" "-foo" "*bar" "NEAR"');
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('   ')).toBe('');
  });

  it('an entity match folds in its claims + incoming backlinks — one call instead of three', async () => {
    const v = await buildRecallVault();
    try {
      const idx = await buildIndexTools(v.root);
      const result = await idx.search!({ query: 'Lovelace' });
      const ada = result.entities.find((e) => e.entity.rel === v.adaRel);
      expect(ada).toBeDefined();
      expect(ada!.claims.map((c) => c.rel)).toContain(v.claimRel);
      expect(ada!.incoming.map((l) => l.from)).toContain(v.engineRel); // Engine links back to Ada
      expect(ada!.snippet).toContain('**'); // highlighted match
    } finally {
      await rmTempDir(v.root);
    }
  });

  it('a claim already folded into a matched entity is NOT also listed standalone', async () => {
    const v = await buildRecallVault();
    try {
      const idx = await buildIndexTools(v.root);
      const result = await idx.search!({ query: 'Lovelace' });
      const matchedRels = new Set(result.entities.map((e) => e.entity.rel));
      for (const c of result.claims) {
        const claim = await idx.claimsForEntity({ entity: c.rel === v.claimRel ? v.adaRel : '' });
        void claim; // sanity anchor only
      }
      expect(result.claims.map((c) => c.rel)).not.toContain(v.claimRel);
      expect(matchedRels.has(v.adaRel)).toBe(true);
    } finally {
      await rmTempDir(v.root);
    }
  });

  it('a query matching only the source (not the entity or claim body) surfaces a standalone source hit', async () => {
    const v = await buildRecallVault();
    try {
      const idx = await buildIndexTools(v.root);
      // buildRecallVault's source.md is the only place "worked on" appears verbatim.
      const result = await idx.search!({ query: 'worked' });
      const sourceRel = path.join(v.sourceDir, 'source.md');
      expect(result.sources.map((s) => s.rel)).toContain(sourceRel);
      expect(result.sources.find((s) => s.rel === sourceRel)!.snippet).toContain('**');
    } finally {
      await rmTempDir(v.root);
    }
  });

  it('a query matching nothing returns an all-empty result', async () => {
    const v = await buildRecallVault();
    try {
      const idx = await buildIndexTools(v.root);
      expect(await idx.search!({ query: 'zzz_nonexistent_term_zzz' })).toEqual({ entities: [], claims: [], sources: [] });
    } finally {
      await rmTempDir(v.root);
    }
  });

  it('an empty query returns an all-empty result, matching grep\'s empty-pattern behavior', async () => {
    const v = await buildRecallVault();
    try {
      const idx = await buildIndexTools(v.root);
      expect(await idx.search!({ query: '' })).toEqual({ entities: [], claims: [], sources: [] });
    } finally {
      await rmTempDir(v.root);
    }
  });

  it('respects limit across the combined entity+claim+source count', async () => {
    const v = await buildRecallVault();
    try {
      const idx = await buildIndexTools(v.root);
      const result = await idx.search!({ query: 'Lovelace', limit: 1 });
      const total = result.entities.length + result.claims.length + result.sources.length;
      expect(total).toBeLessThanOrEqual(1);
    } finally {
      await rmTempDir(v.root);
    }
  });

  it('the live vault-walker tool surface has no search capability — capability-gated, not a breaking interface change', async () => {
    const v = await buildRecallVault();
    try {
      const live = makeReadOnlyTools(v.root);
      expect(live.search).toBeUndefined();
    } finally {
      await rmTempDir(v.root);
    }
  });
});

describe('library index — zero fs reads once built (SPEC-0061 T1 AC)', () => {
  it('every RecallTools method serves from the store alone, with zero node:fs calls', async () => {
    const v = await buildRecallVault();
    try {
      const idx = await buildIndexTools(v.root);
      const readFileSpy = vi.spyOn(fs, 'readFile');
      const readdirSpy = vi.spyOn(fs, 'readdir');
      await idx.entityLookup({ query: '' });
      await idx.claimsForEntity({ entity: v.adaRel });
      await idx.linkTraversal({ entity: v.adaRel });
      await idx.readNode({ rel: v.adaRel });
      await idx.readSource({ dir: v.sourceDir });
      await idx.grep({ pattern: 'programmer' });
      await idx.search!({ query: 'Lovelace' });
      expect(readFileSpy).not.toHaveBeenCalled();
      expect(readdirSpy).not.toHaveBeenCalled();
      readFileSpy.mockRestore();
      readdirSpy.mockRestore();
    } finally {
      await rmTempDir(v.root);
    }
  });
});
