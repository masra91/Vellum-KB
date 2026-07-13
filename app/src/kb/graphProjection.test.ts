// Graph projection (SPEC-0058 STATE-2) — equivalence + precompute proof, through the REAL read path.
//
// The projection's contract: serving Explore (`buildNeighborhood` / `listExploreEntities`) and Health
// (`buildHealthReport`) from the precomputed in-memory snapshot must be BYTE-IDENTICAL to serving them
// from the live `makeReadOnlyTools` vault walk — only without the per-mount filesystem cost. So the core
// test computes the projection from a real seeded git vault, then asserts the projection-backed assembly
// deep-equals the live-tools assembly. A second test proves the O(N²) backlink scan is done ONCE at
// compute time (precomputed), not on the render path.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildRecallVault, type RecallVault } from '../../test/recallVault';
import { rmTempDir } from '../../test/tempVault';
import { makeReadOnlyTools } from './recallTools';
import { computeGraphProjection, makeProjectionTools } from './graphProjection';
import { buildNeighborhood, listExploreEntities } from './explorePanel';
import { buildHealthReport } from './healthPanel';
import { renderEntityNode, type EntityNode } from './connectDoc';
import { renderClaimMd } from './claimDoc';
import type { ClaimDecision } from './claims';
import { ulid } from './ulid';

describe('graph projection — projection-backed reads equal the live vault walk (SPEC-0058 STATE-2)', () => {
  let v: RecallVault;
  let live: ReturnType<typeof makeReadOnlyTools>;
  let proj: ReturnType<typeof makeProjectionTools>;

  beforeAll(async () => {
    v = await buildRecallVault(); // Ada Lovelace ↔ Analytical Engine, one grounded claim, one source
    live = makeReadOnlyTools(v.root);
    const graph = await computeGraphProjection(v.root, () => '2026-06-28T00:00:00.000Z');
    proj = makeProjectionTools(graph);
  });
  afterAll(async () => {
    await rmTempDir(v.root);
  });

  it('listExploreEntities — identical entity list (search picker)', async () => {
    expect(await listExploreEntities(proj)).toEqual(await listExploreEntities(live));
  });

  it('buildNeighborhood(focus=Ada) — identical center + claims + neighbors + backlink direction', async () => {
    const a = await buildNeighborhood(proj, 'Ada Lovelace');
    const b = await buildNeighborhood(live, 'Ada Lovelace');
    expect(a).toEqual(b);
    // sanity: the projection actually produced the neighborhood (not an empty/found:false degrade)
    expect(a.found).toBe(true);
    expect(a.center?.name).toBe('Ada Lovelace');
    expect(a.neighbors.map((n) => n.name)).toContain('Analytical Engine');
  });

  it('buildNeighborhood(focus=Engine) — identical incoming/outgoing from the OTHER side', async () => {
    expect(await buildNeighborhood(proj, 'Analytical Engine')).toEqual(await buildNeighborhood(live, 'Analytical Engine'));
  });

  it('buildNeighborhood(no focus) — identical default (highest-confidence) landing', async () => {
    expect(await buildNeighborhood(proj)).toEqual(await buildNeighborhood(live));
  });

  it('buildHealthReport — identical structural scan (orphans/thin/dangling/counts)', async () => {
    expect(await buildHealthReport(proj)).toEqual(await buildHealthReport(live));
  });
});

describe('graph projection — the O(N²) backlink scan is PRECOMPUTED, not on the render path', () => {
  it('computeGraphProjection inverts links into per-entity backlinks (the live per-mount scan, done once)', async () => {
    const v = await buildRecallVault();
    try {
      const graph = await computeGraphProjection(v.root, () => 'T');
      // Engine links to Ada → Ada has an incoming backlink FROM the engine, precomputed in the snapshot.
      expect(graph.backlinks[v.adaRel].map((l) => l.from)).toContain(v.engineRel);
      // Ada links to Engine → Engine has an incoming backlink FROM Ada.
      expect(graph.backlinks[v.engineRel].map((l) => l.from)).toContain(v.adaRel);
      // The projection-backed linkTraversal returns those precomputed backlinks with ZERO filesystem reads
      // (the snapshot is the only input) — an O(degree) lookup, not the live O(N+M) candidate walk.
      const { incoming } = await makeProjectionTools(graph).linkTraversal({ entity: v.adaRel });
      expect(incoming.map((l) => l.from)).toContain(v.engineRel);
    } finally {
      await rmTempDir(v.root);
    }
  });
});

// QD-2 fast-follow on #468 — backlink-SOURCE fidelity. The live `linkTraversal.incoming` walks EVERY `.md`
// under entities/+claims/ as a backlink source, including files that don't parse as a valid entity/claim. A
// `[[validEntity]]` inside a MALFORMED entity or an ORPHAN claim (subject merged away) is a backlink live
// counts — the projection must match (more likely on a large/merged vault, the real target). NOTE the
// CONSUMERS (`buildNeighborhood` filters incoming to valid entities; `buildHealthReport` doesn't use
// linkTraversal) already drop non-entity sources — so #468's RENDERED output was correct; this keeps the raw
// `linkTraversal` adapter faithful (the right invariant for a drop-in tool surface).
describe('graph projection — backlink-source fidelity vs live, incl. malformed/orphan files (QD #468 fast-follow)', () => {
  async function seedWithStragglers(): Promise<{ root: string; engineRel: string }> {
    const v = await buildRecallVault();
    // A MALFORMED entity (no frontmatter → entityLookup skips it) that links to a valid entity.
    await fs.mkdir(path.join(v.root, 'entities', 'concept'), { recursive: true });
    await fs.writeFile(path.join(v.root, 'entities', 'concept', 'broken.md'), 'garbage, no frontmatter — but mentions [[entities/concept/analytical-engine.md]]\n', 'utf8');
    // An ORPHAN claim (subject = a merged-away entity that no longer exists → claimsForEntity never returns it).
    await fs.mkdir(path.join(v.root, 'claims', 'ghost'), { recursive: true });
    await fs.writeFile(
      path.join(v.root, 'claims', 'ghost', 'orphan.md'),
      '---\nid: 01ORPHAN\nsubject: entities/ghost/merged-away.md\nstatus: fact\nconfidence: 0.5\n---\nA fact mentioning [[entities/concept/analytical-engine.md]].\n',
      'utf8',
    );
    return { root: v.root, engineRel: v.engineRel };
  }

  it('the raw linkTraversal.incoming matches live exactly — counts the malformed entity + orphan claim as backlink sources', async () => {
    const { root, engineRel } = await seedWithStragglers();
    try {
      const live = makeReadOnlyTools(root);
      const proj = makeProjectionTools(await computeGraphProjection(root, () => 'T'));
      const liveIn = (await live.linkTraversal({ entity: engineRel })).incoming.map((l) => l.from).sort();
      const projIn = (await proj.linkTraversal({ entity: engineRel })).incoming.map((l) => l.from).sort();
      expect(projIn).toEqual(liveIn); // FAILS-BEFORE: projection missed the malformed/orphan sources
      expect(liveIn).toContain('entities/concept/broken.md'); // the live superset really includes them
      expect(liveIn).toContain('claims/ghost/orphan.md');
    } finally {
      await rmTempDir(root);
    }
  });

  it('buildNeighborhood + buildHealthReport stay byte-identical to live (the consumers filter non-entity sources — #468 output was always correct)', async () => {
    const { root } = await seedWithStragglers();
    try {
      const live = makeReadOnlyTools(root);
      const proj = makeProjectionTools(await computeGraphProjection(root, () => 'T'));
      expect(await buildNeighborhood(proj, 'Analytical Engine')).toEqual(await buildNeighborhood(live, 'Analytical Engine'));
      expect(await buildHealthReport(proj)).toEqual(await buildHealthReport(live));
    } finally {
      await rmTempDir(root);
    }
  });
});

// #505: collectAllClaims used to call claimsForEntity ONCE PER ENTITY, and each call re-walked +
// re-parsed EVERY claim file — O(N·M) reads. A third full re-read of every entity/claim file backed
// the backlink scan on top of that. Prove the fix: total reads are exactly N (entities) + M (claims) +
// S (distinct cited source dirs), never a function of N×M.
describe('graph projection — one walk, not O(N·M) (#505)', () => {
  it('computeGraphProjection reads each entity/claim/source file exactly once', async () => {
    const v = await buildRecallVault(); // seeds 2 entities, 1 claim, 1 source
    try {
      const ts = '2026-07-12T00:00:00.000Z';
      const ENTITY_COUNT = 10;
      const CLAIMS_PER_ENTITY = 3;
      for (let i = 0; i < ENTITY_COUNT; i++) {
        const rel = `entities/bulk/e${i}.md`;
        const node: EntityNode = {
          id: ulid(),
          kind: 'concept',
          name: `Bulk Entity ${i}`,
          confidence: 0.5,
          aliases: [],
          tags: [],
          derivedFrom: [v.sourceDir],
          resolvedFrom: [],
          createdAt: ts,
          updatedAt: ts,
        };
        await fs.mkdir(path.dirname(path.join(v.root, rel)), { recursive: true });
        await fs.writeFile(path.join(v.root, rel), renderEntityNode(node));
        for (let j = 0; j < CLAIMS_PER_ENTITY; j++) {
          const claim: ClaimDecision = {
            statement: `Bulk fact ${i}-${j}.`,
            status: 'fact',
            confidence: 0.5,
            mentions: [],
            relatesTo: [],
          };
          const claimRel = `claims/bulk/e${i}-c${j}.md`;
          await fs.mkdir(path.dirname(path.join(v.root, claimRel)), { recursive: true });
          await fs.writeFile(path.join(v.root, claimRel), renderClaimMd(claim, { id: ulid(), subject: rel, derivedFrom: v.sourceDir, createdAt: ts }));
        }
      }
      // N = 2 (base) + 10 bulk = 12 entities; M = 1 (base) + 30 bulk = 31 claims; S = 1 (every claim
      // cites the SAME source dir, deduped). If the old per-entity claimsForEntity walk were still in
      // place, this alone would be N_entities(12) × M_claims(31) ≈ 372+ claim-file reads.
      const spy = vi.spyOn(fs, 'readFile');
      try {
        await computeGraphProjection(v.root, () => ts);
      } finally {
        const reads = spy.mock.calls.length;
        spy.mockRestore();
        expect(reads).toBe(12 + 31 + 1);
      }
    } finally {
      await rmTempDir(v.root);
    }
  });
});
