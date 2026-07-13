// Connect stage tests (SPEC-0020). Real FS + git + worktrees against a throwaway temp vault
// (TEST-18); the decider is injected so nothing shells out to copilot (TEST-2).
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { ulid, dateShard } from './ulid';
import { renderEntityNode, entityFileRel, LINKS_BLOCK_START } from './connectDoc';
import { applyProse } from './composeDoc';
import { connectOne, readConnectQueue, ConnectStage, DEFAULT_MAX_ATTEMPTS, linkOne, linkOneWouldChange, readLinkQueue, dedupClaimsOnce, linkOrphansOnce, listConnectSetAsideItems, retryConnectItem, dismissConnectItem, readResolveAudit, readCandidates, readEntityNodes } from './connectStage';
import { captureToInbox } from './ingest';
import { cohesionFromFiles } from './cohesion';
import { resolveIndexLockPath, GATE3_STALE_AGE_MS } from './canonicalLockHeal';
import { readDisambiguationDecisions, decisionForPair } from './disambiguationDecisions';
import { readDisambiguationDirectives, directiveForIdentity } from './directives';
import type { DevLog } from './devlog';
import { renderClaimMd } from './claimDoc';
import { findOpenReviews, answerReview } from './reviewStore';
import type { ConnectDecider, CandidateSet } from './connectAgent';
import { parseConnectDecision } from './connect';
import type { Candidate, ConnectDecision } from './connect';
import { Mutex } from './stageLock';
import { planSetAsideAction } from './pipelineControl'; // the stage-agnostic seam (DEV-3 #162)
import { toSetAsideViews } from './pipelineStatusView'; // the Status-view union (DEV-3 #162)

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

async function withTempVault(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(path.join(dir, 'vault'));
  } finally {
    await rmTempDir(dir);
  }
}

/** Commit whatever is in the working tree so the connect worktree (based on main) sees it. */
async function commitAll(root: string, msg: string): Promise<void> {
  const git = simpleGit(root);
  await git.add('-A');
  await git.commit(msg);
}

/** Seed a candidate file in the working zone and return its id. */
async function seedCandidate(root: string, kind: string, name: string, sourceId: string): Promise<string> {
  const id = ulid();
  const rel = path.join('candidates', dateShard(id), `${id}.json`);
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const cand: Candidate = { id, sourceId, kind, name, confidence: 0.8, mentions: [name] };
  await fs.writeFile(dest, JSON.stringify(cand, null, 2), 'utf8');
  return id;
}

/** Seed an existing canonical entity node; returns { id, rel }. `aliases` are added alongside the
 *  self-id alias (real nodes carry both) — used to test alias-based link resolution (COHERE-1). */
async function seedNode(root: string, kind: string, name: string, derivedFrom: string[], aliases: string[] = [], tags: string[] = [], properties: Record<string, string> = {}): Promise<{ id: string; rel: string }> {
  const id = ulid();
  const rel = entityFileRel(kind, name, id); // COMPOSE-6: human leaf (real case + spaces), kind dir lowercase
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(
    dest,
    renderEntityNode({
      id,
      kind,
      name,
      confidence: 0.9,
      aliases: [id, ...aliases],
      derivedFrom,
      resolvedFrom: [],
      tags,
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
      createdAt: '2026-05-30T00:00:00Z',
      updatedAt: '2026-05-30T00:00:00Z',
    }),
    'utf8',
  );
  return { id, rel };
}

/** A claim file subject→entityRel, used to test repoint-on-merge. */
async function seedClaim(root: string, subjectRel: string, statement: string): Promise<string> {
  const id = ulid();
  const rel = path.join('claims', dateShard(id), `${id}.md`);
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const fm = ['---', `id: ${id}`, `subject: ${subjectRel}`, 'status: fact', 'confidence: 0.9', '---', '', statement, ''].join('\n');
  await fs.writeFile(dest, fm, 'utf8');
  return rel;
}

/** A claim carrying `relatesTo` hints (what Claims leaves for Connect to promote into links). */
async function seedClaimRelatesTo(root: string, subjectRel: string, statement: string, relatesTo: string[]): Promise<string> {
  const id = ulid();
  const rel = path.join('claims', dateShard(id), `${id}.md`);
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const fm = [
    '---',
    `id: ${id}`,
    `subject: ${subjectRel}`,
    'status: fact',
    'confidence: 0.9',
    `relatesTo: ${JSON.stringify(relatesTo)}`,
    '---',
    '',
    statement,
    '',
  ].join('\n');
  await fs.writeFile(dest, fm, 'utf8');
  return rel;
}

/** Seed an archived `source.md` carrying curated property values (scope/sensitivity) — META S1b reads
 *  these off the node's member sources. Returns the source's ULID (a real ULID so `sourceFileRel` maps it). */
async function seedSource(root: string, opts: { scope?: string; sensitivity?: string } = {}): Promise<string> {
  const id = ulid();
  const dest = path.join(root, 'sources', dateShard(id), id, 'source.md');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const fm = [
    '---',
    `id: ${id}`,
    'class: primary',
    'kind: text',
    ...(opts.scope ? [`scope: ${opts.scope}`] : []),
    ...(opts.sensitivity ? [`sensitivity: ${opts.sensitivity}`] : []),
    'raw: raw.md',
    '---',
    '',
    '# A source',
    '',
  ].join('\n');
  await fs.writeFile(dest, fm, 'utf8');
  return id;
}

/** A decider that puts ALL candidates into one cluster with the given name (+ optional merge/fold). */
function oneClusterDecider(
  canonicalName: string,
  opts: { existingNodeId?: string; mergeExistingNodeIds?: string[]; dates?: Array<{ label: string; value: string }> } = {},
): ConnectDecider {
  return async (set: CandidateSet): Promise<ConnectDecision> => ({
    blockKey: set.blockKey,
    clusters: [
      {
        canonicalName,
        memberCandidateIds: set.candidates.map((c) => c.id),
        confidence: 0.95,
        ...(opts.existingNodeId ? { existingNodeId: opts.existingNodeId } : {}),
        ...(opts.mergeExistingNodeIds ? { mergeExistingNodeIds: opts.mergeExistingNodeIds } : {}),
        ...(opts.dates ? { dates: opts.dates } : {}),
      },
    ],
    agent: { via: 'copilot', model: 'test' },
  });
}

async function listEntityFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.md')) out.push(path.relative(root, p));
    }
  }
  await walk(path.join(root, 'entities'));
  return out.sort();
}

describe.skipIf(!gitAvailable)('readConnectQueue — blocking (CONNECT-4)', () => {
  it('groups candidates by kind + normalized name into bounded sets', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await seedCandidate(root, 'person', 'steve  jobs', '01S2'); // same block (normalized)
      await seedCandidate(root, 'person', 'Tim Cook', '01S3'); // different block
      await commitAll(root, 'seed candidates');

      const q = await readConnectQueue(root);
      expect(q).toHaveLength(2); // two blocks: {steve jobs}, {tim cook}
      const steve = q.find((s) => s.blockKey === 'person|steve jobs');
      expect(steve?.candidates).toHaveLength(2); // both Steve spellings grouped
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — born-resolved nodes (CONNECT-1/3/7/8)', () => {
  it('resolves a candidate block into one human-named node, consumes the candidates, clean tree', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await seedCandidate(root, 'person', 'Steve Jobs', '01S2');
      await commitAll(root, 'seed');

      const res = await connectOne(root, 'person|steve jobs', oneClusterDecider('Steve Jobs'));
      expect(res.ok).toBe(true);
      expect(res.nodeRels).toEqual(['entities/person/Steve Jobs.md']); // human filename — real case + spaces (CONNECT-7 / COMPOSE-6)

      const md = await fs.readFile(path.join(root, 'entities/person/Steve Jobs.md'), 'utf8');
      expect(md).toContain('# Steve Jobs');
      // multi-source provenance (CONNECT-8) — order-independent
      expect(md).toContain('01S1');
      expect(md).toContain('01S2');
      expect(md).toMatch(/derivedFrom: \[/);
      expect(md).toMatch(/resolvedFrom: \[/);

      // candidates consumed (CONNECT-17); canonical tree clean (ORCH-3)
      expect(await readConnectQueue(root)).toHaveLength(0);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });

  it('dedups: two same-name candidates from different sources → ONE node (CONNECT-1)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await seedCandidate(root, 'person', 'Steve Jobs', '01S2');
      await commitAll(root, 'seed');
      await connectOne(root, 'person|steve jobs', oneClusterDecider('Steve Jobs'));
      expect(await listEntityFiles(root)).toEqual(['entities/person/Steve Jobs.md']);
    });
  });

  // SPEC-0025 META S1b — the curated scope/sensitivity property VALUES carried from a node's sources.
  it('META S1b: carries scope + MOST-RESTRICTIVE sensitivity from the node\'s sources onto its Properties', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const s1 = await seedSource(root, { scope: 'work', sensitivity: 'shareable' });
      const s2 = await seedSource(root, { scope: 'work', sensitivity: 'internal' });
      await seedCandidate(root, 'person', 'Ada Lovelace', s1);
      await seedCandidate(root, 'person', 'Ada Lovelace', s2);
      await commitAll(root, 'seed');

      await connectOne(root, 'person|ada lovelace', oneClusterDecider('Ada Lovelace'));
      const md = await fs.readFile(path.join(root, 'entities/person/Ada Lovelace.md'), 'utf8');
      expect(md).toMatch(/^scope: work$/m); // uniform across both sources → carried
      expect(md).toMatch(/^sensitivity: internal$/m); // internal ≻ shareable (SENSE-3 most-restrictive)
    });
  });

  it('META S1b: scope is OMITTED when the node\'s sources disagree (ambiguous), sensitivity still folds', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const s1 = await seedSource(root, { scope: 'work', sensitivity: 'internal' });
      const s2 = await seedSource(root, { scope: 'personal', sensitivity: 'shareable' });
      await seedCandidate(root, 'person', 'Ada Lovelace', s1);
      await seedCandidate(root, 'person', 'Ada Lovelace', s2);
      await commitAll(root, 'seed');

      await connectOne(root, 'person|ada lovelace', oneClusterDecider('Ada Lovelace'));
      const md = await fs.readFile(path.join(root, 'entities/person/Ada Lovelace.md'), 'utf8');
      expect(md).not.toMatch(/^scope:/m); // work vs personal → ambiguous → omitted (no thrash)
      expect(md).toMatch(/^sensitivity: internal$/m); // most-restrictive still applies
    });
  });

  it('META S1b: a MERGE keeps the LOSER\'s most-restrictive sensitivity — never down-classifies (CONNECT-10, security/QD-2)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // canonical B is `shareable`; the loser A carries `internal`. Merging A into B must NOT down-classify
      // the result to `shareable` (which would over-share A's internal-sourced material on the egress facet).
      const a = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA'], [], [], { sensitivity: 'internal' });
      const b = await seedNode(root, 'person', 'Steven Jobs', ['sources/b/01SB'], [], [], { sensitivity: 'shareable' });
      const s1 = await seedSource(root, { sensitivity: 'shareable' });
      await seedCandidate(root, 'person', 'Steve Jobs', s1);
      await commitAll(root, 'seed');

      // canonical = B (shareable), merge the loser A (internal). (Block key normalizes both to 'steve jobs'.)
      await connectOne(root, 'person|steve jobs', oneClusterDecider('Steve Jobs', { existingNodeId: b.id, mergeExistingNodeIds: [a.id] }));
      const files = await listEntityFiles(root);
      expect(files).toHaveLength(1); // one surviving canonical node
      const md = await fs.readFile(path.join(root, files[0]), 'utf8');
      expect(md).toMatch(/^sensitivity: internal$/m); // ← loser A's `internal` preserved, NOT down-classified
    });
  });

  it('META S2: a coined event date lands on the node as a `<label>: <date>` + `<label>_precision:` Property', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'organization', 'Apple', '01S1');
      await commitAll(root, 'seed');

      await connectOne(root, 'organization|apple', oneClusterDecider('Apple', { dates: [{ label: 'Founded', value: '1976' }] }));
      const md = await fs.readFile(path.join(root, 'entities/organization/Apple.md'), 'utf8');
      expect(md).toMatch(/^founded: 1976-01-01$/m); // full date (padded) — Bases date-sortable
      expect(md).toMatch(/^founded_precision: year$/m); // precision honest (year-only "1976")
    });
  });

  it('META S2: a MERGE keeps BOTH nodes\' event dates (folded by label, idempotent)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // canonical B has `released`; loser A has `founded`. The merge must carry both.
      const a = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      const b = await seedNode(root, 'person', 'Steven Jobs', ['sources/b/01SB']);
      // give A a date by re-rendering it with one (seedNode doesn't take dates; write directly via the merge path).
      await fs.writeFile(path.join(root, a.rel), (await fs.readFile(path.join(root, a.rel), 'utf8')).replace(/^provenance:/m, 'founded: 1976-01-01\nfounded_precision: year\nprovenance:'), 'utf8');
      await fs.writeFile(path.join(root, b.rel), (await fs.readFile(path.join(root, b.rel), 'utf8')).replace(/^provenance:/m, 'released: 2007-06-29\nreleased_precision: day\nprovenance:'), 'utf8');
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed');

      await connectOne(root, 'person|steve jobs', oneClusterDecider('Steve Jobs', { existingNodeId: b.id, mergeExistingNodeIds: [a.id] }));
      const files = await listEntityFiles(root);
      expect(files).toHaveLength(1);
      const md = await fs.readFile(path.join(root, files[0]), 'utf8');
      expect(md).toMatch(/^founded: 1976-01-01$/m); // loser A's date preserved on merge
      expect(md).toMatch(/^released: 2007-06-29$/m); // canonical B's date kept
    });
  });

  it('META S1b: a source with NO scope/sensitivity → no curated values emitted (clean, no empty keys)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const s1 = await seedSource(root, {}); // bare source, no scope/sensitivity frontmatter
      await seedCandidate(root, 'person', 'Ada Lovelace', s1);
      await commitAll(root, 'seed');

      await connectOne(root, 'person|ada lovelace', oneClusterDecider('Ada Lovelace'));
      const md = await fs.readFile(path.join(root, 'entities/person/Ada Lovelace.md'), 'utf8');
      expect(md).not.toMatch(/^scope:/m);
      expect(md).not.toMatch(/^sensitivity:/m);
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — fold into existing node (CONNECT-9)', () => {
  it('extends an existing node\'s provenance instead of creating a duplicate', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const existing = await seedNode(root, 'person', 'Steve Jobs', ['sources/old/01S0']);
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed');

      await connectOne(root, 'person|steve jobs', oneClusterDecider('Steve Jobs', { existingNodeId: existing.id }));

      expect(await listEntityFiles(root)).toEqual(['entities/person/Steve Jobs.md']); // no duplicate
      const md = await fs.readFile(path.join(root, existing.rel), 'utf8');
      expect(md).toContain('sources/old/01S0'); // kept
      expect(md).toContain('01S1'); // folded in
      expect(md).toContain(`id: ${existing.id}`); // identity preserved
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — merge two existing nodes, delete loser, repoint claims (CONNECT-10/11)', () => {
  it('picks canonical, deletes the loser file (no tombstone), repoints the loser\'s claim', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const a = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      const b = await seedNode(root, 'person', 'Steven Jobs', ['sources/b/01SB']);
      const claimRel = await seedClaim(root, b.rel, 'Co-founded Apple.'); // claim points at the loser
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed two nodes + a claim');

      // Fold into A; merge B into it. (Block key is normalized 'steve jobs' for both.)
      await connectOne(root, 'person|steve jobs', oneClusterDecider('Steve Jobs', { existingNodeId: a.id, mergeExistingNodeIds: [b.id] }));

      const files = await listEntityFiles(root);
      expect(files).toContain(a.rel);
      expect(files).not.toContain(b.rel); // loser DELETED — no tombstone (CONNECT-10)

      // loser is recoverable via git history (CONNECT-10 rationale)
      const log = await simpleGit(root).raw('log', '--all', '--oneline', '--', b.rel);
      expect(log.trim().length).toBeGreaterThan(0);

      // the claim was repointed to the canonical node (CONNECT-11)
      const claimMd = await fs.readFile(path.join(root, claimRel), 'utf8');
      expect(claimMd).toContain(`subject: ${a.rel}`);
      // and shows up in the canonical node's regenerated claims block
      const aMd = await fs.readFile(path.join(root, a.rel), 'utf8');
      expect(aMd).toContain('Co-founded Apple.');
      expect(aMd).toContain('kb:claims:start');
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — ambiguity parks for Review (CONNECT-15)', () => {
  it('raises a review, applies NO resolution, and the block leaves the active queue (parked)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed');

      const reviewer: ConnectDecider = async (set) => ({
        blockKey: set.blockKey,
        clusters: [{ canonicalName: 'Steve Jobs', memberCandidateIds: set.candidates.map((c) => c.id), confidence: 0.4 }],
        reviews: [{ question: 'Is this the Apple founder?', detail: 'Only a bare name; ambiguous.' }],
        agent: { via: 'copilot', model: 'test' },
      });
      const res = await connectOne(root, 'person|steve jobs', reviewer);
      expect(res.parked).toBe(true);
      expect(res.nodeRels).toHaveLength(0); // NO merge applied
      expect(await listEntityFiles(root)).toHaveLength(0);
      expect(await readConnectQueue(root)).toHaveLength(0); // parked → out of the active queue (REVIEW-5)

      // a review artifact exists
      const reviewsDir = path.join(root, 'reviews');
      const hasReview = await fs
        .readdir(reviewsDir)
        .then(() => true)
        .catch(() => false);
      expect(hasReview).toBe(true);
    });
  });

  // REVIEW-16: the agent's per-candidate {id, gloss} is enriched into decision-grade subject context
  // ({name, sourceRel, gloss}) on the real park path — the stage joins the id to the candidate's name
  // + source-dir rel (the working Obsidian link); the agent only authors the gloss.
  it('enriches the parked review subject with per-candidate {name, title, sourceRel, gloss} (REVIEW-16)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // two same-name candidates from DIFFERENT sources — the textbook disambiguation case.
      await seedCandidate(root, 'person', 'Benton', '01S1');
      await seedCandidate(root, 'person', 'Benton', '01S2');
      await commitAll(root, 'seed');

      const reviewer: ConnectDecider = async (set) => ({
        blockKey: set.blockKey,
        clusters: set.candidates.map((c) => ({ canonicalName: c.name, memberCandidateIds: [c.id], confidence: 0.4 })),
        // glosses authored per candidate, keyed by id, tagged with the source so we can assert the join.
        reviews: [
          {
            question: 'Is Benton (fishing-trip notes) the same person as Benton (wedding list)?',
            detail: 'Same name, two sources — ambiguous.',
            candidates: set.candidates.map((c) => ({ id: c.id, gloss: `gloss for ${c.sourceId}` })),
          },
        ],
        agent: { via: 'copilot', model: 'test' },
      });
      const res = await connectOne(root, 'person|benton', reviewer);
      expect(res.parked).toBe(true);

      const review = (await findOpenReviews(root))[0];
      expect(review.subject.candidates).toBeDefined();
      const cands = review.subject.candidates!;
      expect(cands).toHaveLength(2);
      // each carries the candidate's NAME (stage-owned), the agent's GLOSS, and the source REL link.
      for (const c of cands) {
        expect(c.name).toBe('Benton');
        expect(c.gloss).toMatch(/^gloss for 01S[12]$/);
        expect(c.sourceRel).toBe(c.gloss.replace('gloss for ', '')); // sourceFileRel passthrough for the non-ULID fixture id
        // PRIN-24: title is always populated; with no readable source.md here it falls back to the
        // candidate name (a human surface name — never the ULID).
        expect(c.title).toBe('Benton');
      }
      // both distinct sources are represented (the whole point — tell the two apart).
      expect(new Set(cands.map((c) => c.sourceRel))).toEqual(new Set(['01S1', '01S2']));
    });
  });

  // PRIN-24 / REVIEW-16 regression: the candidate "Open in Obsidian" link must target the source
  // FILE (`<dir>/source.md`), not the bare source DIR — opening a directory is "file not found" —
  // and the row must show the source's human TITLE (read from source.md), never the raw ULID.
  // (Fails before the sourceDirRel→sourceFileRel + persisted-title fix: sourceRel was the dir,
  // no `/source.md`, and there was no title field at all.)
  it('targets the source FILE (<dir>/source.md) and persists its human title for a real ULID source', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // real ULID source ids → the deterministic sources/<shard>/<id> layout (not a unit-fixture id),
      // each with a real source.md carrying a distinct human title to resolve.
      const sa = ulid();
      const sb = ulid();
      await seedSourceMd(root, sa, '---\nid: x\noriginalName: Fishing trip notes.md\n---\n\nbody\n');
      await seedSourceMd(root, sb, '---\nid: y\nkind: text\n---\n\n# Wedding guest list\n\nnames…\n');
      await seedCandidate(root, 'person', 'Benton', sa);
      await seedCandidate(root, 'person', 'Benton', sb);
      await commitAll(root, 'seed');

      const reviewer: ConnectDecider = async (set) => ({
        blockKey: set.blockKey,
        clusters: set.candidates.map((c) => ({ canonicalName: c.name, memberCandidateIds: [c.id], confidence: 0.4 })),
        reviews: [
          {
            question: 'Is Benton (A) the same person as Benton (B)?',
            detail: 'Same name, two sources — ambiguous.',
            candidates: set.candidates.map((c) => ({ id: c.id, gloss: `gloss for ${c.sourceId}` })),
          },
        ],
        agent: { via: 'copilot', model: 'test' },
      });
      const res = await connectOne(root, 'person|benton', reviewer);
      expect(res.parked).toBe(true);

      const cands = (await findOpenReviews(root))[0].subject.candidates!;
      expect(cands).toHaveLength(2);
      for (const c of cands) {
        expect(c.sourceRel!.endsWith(`${path.sep}source.md`)).toBe(true); // FILE, not dir
        expect(isUlidLike(c.title)).toBe(false); // PRIN-24: never the raw ULID
      }
      // exactly the deterministic per-source `source.md` paths (both sources represented).
      expect(new Set(cands.map((c) => c.sourceRel))).toEqual(
        new Set([
          path.join('sources', dateShard(sa), sa, 'source.md'),
          path.join('sources', dateShard(sb), sb, 'source.md'),
        ]),
      );
      // titles come from each source's source.md (originalName / first heading), per source id.
      const titleBySource = new Map(cands.map((c) => [c.sourceRel!.split(path.sep).at(-2), c.title]));
      expect(titleBySource.get(sa)).toBe('Fishing trip notes.md');
      expect(titleBySource.get(sb)).toBe('Wedding guest list');
    });
  });
});

/** Write a `source.md` at the deterministic location for a real source ULID. */
async function seedSourceMd(root: string, sourceId: string, content: string): Promise<void> {
  const dir = path.join(root, 'sources', dateShard(sourceId), sourceId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'source.md'), content, 'utf8');
}

/** A ULID-shaped string (26-char Crockford) — used to assert a title is NEVER a raw ULID. */
function isUlidLike(s: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(s);
}

describe.skipIf(!gitAvailable)('connectOne — failure never loses candidates; set aside after K (CONNECT-14)', () => {
  it('retries a poison block then sets it aside, leaving candidates intact', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed');

      const failing: ConnectDecider = async () => {
        throw new Error('boom');
      };
      const stage = new ConnectStage(root, failing, new Mutex(), DEFAULT_MAX_ATTEMPTS);
      for (let n = 0; n < DEFAULT_MAX_ATTEMPTS + 1; n++) await stage.poke();

      expect(await readConnectQueue(root)).toHaveLength(0); // set aside → out of active queue
      expect(await listEntityFiles(root)).toHaveLength(0); // no node fabricated
      // candidate file still present (never lost)
      const audit = await readResolveAudit(root);
      expect(audit).toContain('"event":"setaside"');
    });
  });

  it('resolves (does NOT wedge/set-aside) when the agent returns existingNodeId:"" (#136)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Grace Hopper', '01S1');
      await commitAll(root, 'seed');

      // The real agent output #136 came from: existingNodeId "" ("no existing node to fold into").
      // Goes through the REAL parse path (was throwing → block failed+set-aside); now coerced to absent.
      const decider: ConnectDecider = async (set) =>
        parseConnectDecision(
          JSON.stringify({
            blockKey: set.blockKey,
            clusters: [{ canonicalName: 'Grace Hopper', memberCandidateIds: set.candidates.map((c) => c.id), existingNodeId: '', confidence: 0.95 }],
          }),
          set.blockKey,
          set.candidates.map((c) => c.id),
        );

      const res = await connectOne(root, 'person|grace hopper', decider);
      expect(res.ok).toBe(true);
      expect(res.setAside).toBe(false); // resolved, not wedged
      expect(res.nodeRels).toEqual(['entities/person/Grace Hopper.md']); // born fresh (COMPOSE-6 human leaf)
      expect(await readConnectQueue(root)).toHaveLength(0); // candidate consumed
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — idempotent / restartable (CONNECT-17)', () => {
  it('a second drain does not duplicate the resolved node', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed');
      const stage = new ConnectStage(root, oneClusterDecider('Steve Jobs'));
      await stage.poke();
      await stage.poke(); // re-poke: candidates already consumed → nothing to do
      expect(await listEntityFiles(root)).toEqual(['entities/person/Steve Jobs.md']);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — signals route to the audit log only (CONNECT-18)', () => {
  it('writes signals into connect/audit.jsonl, never into the node', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed');

      const withSignal: ConnectDecider = async (set) => ({
        blockKey: set.blockKey,
        clusters: [{ canonicalName: 'Steve Jobs', memberCandidateIds: set.candidates.map((c) => c.id), confidence: 0.9 }],
        signals: [{ type: 'note', note: 'one plausible match only' }],
        agent: { via: 'copilot', model: 'test' },
      });
      await connectOne(root, 'person|steve jobs', withSignal);

      const audit = await readResolveAudit(root);
      const sig = audit
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((o) => o.event === 'signal');
      expect(sig).toMatchObject({ stage: 'connect', type: 'note', note: 'one plausible match only' });
      const node = await fs.readFile(path.join(root, 'entities/person/Steve Jobs.md'), 'utf8');
      expect(node).not.toContain('one plausible match only');
    });
  });
});

describe.skipIf(!gitAvailable)('linkOne — promote relatesTo hints into [[wikilinks]] (CONNECT-12/13)', () => {
  it('resolves a relatesTo hint by name to a canonical node and renders a real [[wikilink]] block', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      const apple = await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedClaimRelatesTo(root, steve.rel, 'Co-founded Apple.', ['Apple']);
      await commitAll(root, 'seed node + relatesTo claim');

      expect(await readLinkQueue(root)).toEqual([steve.rel]); // Steve's claim has a hint
      const res = await linkOne(root, steve.rel);
      expect(res.changed).toBe(true);
      expect(res.links).toBe(1);

      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).toContain(LINKS_BLOCK_START);
      expect(md).toContain(`[[${apple.rel}|`); // VAULT-12: alias form `[[path|Name]]` to the canonical node
      expect(md).toContain(`[[${apple.rel}|Apple]]`); // shows the entity name, not the raw path
      expect((await simpleGit(root).status()).isClean()).toBe(true); // ORCH-3
    });
  });

  it('COHERE-1 coverage: a relatesTo hint matching an entity ALIAS resolves to that node', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      const apple = await seedNode(root, 'organization', 'Apple', ['sources/b/01SB'], ['Apple Inc']); // alias
      await seedClaimRelatesTo(root, steve.rel, 'Worked at Apple Inc.', ['Apple Inc']); // hint = the alias
      await commitAll(root, 'seed node + alias-hint claim');

      const res = await linkOne(root, steve.rel);
      expect(res.links).toBe(1); // resolved via the alias, not the canonical name
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).toContain(`[[${apple.rel}|Apple]]`); // links to Apple, displayed by its canonical name
    });
  });

  it('COHERE-1 bare-[[Name]]: resolves a bare woven prose link to the entity path; leaves an unknown one bare', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      const harrie = await seedNode(root, 'person', 'Harrie', ['sources/b/01SB']);
      // Compose-style woven prose: a bare known link + a bare unknown link.
      const withProse = applyProse(await fs.readFile(path.join(root, steve.rel), 'utf8'), 'Jobs worked with [[Harrie]] and [[Ghost Person]].');
      await fs.writeFile(path.join(root, steve.rel), withProse, 'utf8');
      await commitAll(root, 'seed node with bare woven prose links');

      const res = await linkOne(root, steve.rel);
      expect(res.changed).toBe(true);
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).toContain(`[[${harrie.rel}|Harrie]]`); // bare [[Harrie]] → entity path (navigable)
      expect(md).toContain('[[Ghost Person]]'); // unknown stays bare (CONNECT-13 — no dangling guess)
      expect(md).not.toContain('Ghost Person.md');
      expect((await simpleGit(root).status()).isClean()).toBe(true); // ORCH-3: advance is clean
    });
  });

  it('is idempotent: a second linkOne on an unchanged node is a no-op (regenerate-whole)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedClaimRelatesTo(root, steve.rel, 'Co-founded Apple.', ['Apple']);
      await commitAll(root, 'seed');

      expect((await linkOne(root, steve.rel)).changed).toBe(true);
      const res2 = await linkOne(root, steve.rel);
      expect(res2.changed).toBe(false); // no churn — block regenerated identically
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });

  it('an unknown target is NOT a dangling guess — it becomes a note signal (CONNECT-13)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedClaimRelatesTo(root, steve.rel, 'Knows someone at Nowhere Inc.', ['Nowhere Inc']);
      await commitAll(root, 'seed');

      const res = await linkOne(root, steve.rel);
      expect(res.links).toBe(0);
      expect(res.unresolved).toContain('Nowhere Inc');
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).not.toContain('[['); // no dangling wikilink rendered
      const audit = await fs.readFile(path.join(root, 'connect', 'audit.jsonl'), 'utf8');
      const note = audit
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((o) => o.event === 'signal' && o.type === 'note');
      expect(note.note).toContain('Nowhere Inc'); // recorded for follow-up, not guessed
    });
  });

  it('an ambiguous target (two nodes share the name) escalates to a yes/no Review — never guessed (CONNECT-15)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']); // entities/organization/Apple.md
      await seedNode(root, 'fruit', 'Apple', ['sources/c/01SC']); // entities/fruit/Apple.md — same name, distinct entity
      await seedClaimRelatesTo(root, steve.rel, 'Likes Apple.', ['Apple']);
      await commitAll(root, 'seed two same-name nodes');

      const res = await linkOne(root, steve.rel);
      expect(res.reviewsRaised).toBe(1); // ambiguous → Review, NOT a silent note (the CONNECT-15 change)
      expect(res.links).toBe(0);
      expect(res.unresolved).not.toContain('Apple'); // escalated, not noted
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).not.toContain('[['); // nothing rendered while parked — never a guess

      // A yes/no Review is open, carrying the merge plan (first match) in its markerKey.
      const open = await findOpenReviews(root);
      expect(open).toHaveLength(1);
      expect(open[0].raisedBy.markerKey).toMatchObject({ kind: 'link', nodeRel: steve.rel, hint: 'Apple' });
      expect(open[0].raisedBy.markerKey.targetRel).toMatch(/entities\/(organization|fruit)\/Apple\.md/);
      expect(open[0].question).toContain('Steve Jobs');

      // Idempotent: a second pass does NOT raise a duplicate (the hint is already asked).
      const again = await linkOne(root, steve.rel);
      expect(again.reviewsRaised).toBe(0);
      expect(again.changed).toBe(false);
      expect(await findOpenReviews(root)).toHaveLength(1);
    });
  });

  it('answering the ambiguous-link Review with CONFIRM renders the proposed [[wikilink]] (CONNECT-15)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedNode(root, 'fruit', 'Apple', ['sources/c/01SC']);
      await seedClaimRelatesTo(root, steve.rel, 'Likes Apple.', ['Apple']);
      await commitAll(root, 'seed');

      await linkOne(root, steve.rel); // raises the review (parked)
      const review = (await findOpenReviews(root))[0];
      const target = review.raisedBy.markerKey.targetRel as string;
      await answerReview(root, new Mutex(), review.id, { verdict: 'confirm' });

      const res = await linkOne(root, steve.rel); // resume: render the Principal-approved link
      expect(res.links).toBe(1);
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).toContain(LINKS_BLOCK_START);
      expect(md).toContain(`[[${target}|`); // exactly the confirmed target (alias form, VAULT-12) — not the other same-name node
    });
  });

  it('answering the ambiguous-link Review with REJECT leaves it a note, no link (CONNECT-15)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedNode(root, 'fruit', 'Apple', ['sources/c/01SC']);
      await seedClaimRelatesTo(root, steve.rel, 'Likes Apple.', ['Apple']);
      await commitAll(root, 'seed');

      await linkOne(root, steve.rel);
      const review = (await findOpenReviews(root))[0];
      await answerReview(root, new Mutex(), review.id, { verdict: 'reject' });

      const res = await linkOne(root, steve.rel); // resume: declined → note, never linked
      expect(res.links).toBe(0);
      expect(res.unresolved).toContain('Apple');
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).not.toContain('[[');
    });
  });

  // REGRESSION (connect.link-error class): linkOne's canonical advance must self-heal a stale
  // `.git/index.lock` like EVERY other canonical writer (ORCH-27). It used to advance via a RAW
  // `git merge --ff-only` that bypassed `reconcileStaleIndexLock`, so a stale lock (the #256 wedge)
  // made it throw `Unable to create '…/index.lock': File exists` for every relatesTo node — links
  // never rendered (isolated nodes / no Obsidian edges) — while decompose/connect self-healed.
  it('heals a stale index.lock instead of throwing connect.link-error (the #256 wedge, second symptom)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      const apple = await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedClaimRelatesTo(root, steve.rel, 'Co-founded Apple.', ['Apple']);
      await commitAll(root, 'seed node + relatesTo claim');

      // A stale `.git/index.lock` left by a crashed / boundedGit-timed-out prior op (#256).
      const lockPath = await resolveIndexLockPath(root);
      await fs.writeFile(lockPath, '', 'utf8');
      const stale = new Date(Date.now() - (GATE3_STALE_AGE_MS + 60_000));
      await fs.utimes(lockPath, stale, stale); // older than the gate-3 threshold → genuinely stale

      // FAILS-BEFORE: raw `merge --ff-only` throws on the present lock. PASSES-AFTER: advanceOrCollide
      // heals the stale lock, advances, and the wikilink renders.
      const res = await linkOne(root, steve.rel);
      expect(res.links).toBe(1);
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).toContain(`[[${apple.rel}|Apple]]`);
      expect(await fs.stat(lockPath).then(() => true).catch(() => false)).toBe(false); // lock healed away
      // The heal records its clear in `.kb/audit.jsonl` (ORCH-27 audits every clear) — that breadcrumb
      // is the only working-tree change, so we assert the link landed, not a byte-clean tree.
    });
  });

  // REGRESSION (connect.link-error / KB-Lead live-vault diagnosis): a link write that hits the
  // bounded-git BLOCK TIMEOUT under bulk-writer contention must RETRY, not silently drop — a transient
  // timeout left 92% of entities permanently unlinked. The drain retries the node in-pass; the link lands.
  it('retries a link write that times out under contention instead of silently dropping it', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      const apple = await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedClaimRelatesTo(root, steve.rel, 'Co-founded Apple.', ['Apple']);
      await commitAll(root, 'seed node + relatesTo claim');

      // A lock whose FIRST `connect:link` section throws a bounded-git block timeout (the live-vault
      // failure), then behaves normally — simulating a transient contention spike.
      class FlakyLinkLock extends Mutex {
        linkFailsLeft = 1;
        run<T>(fn: () => Promise<T>, label?: string): Promise<T> {
          if (label === 'connect:link' && this.linkFailsLeft > 0) {
            this.linkFailsLeft -= 1;
            return Promise.reject(new Error('block timeout reached'));
          }
          return super.run(fn, label);
        }
      }
      const events: { level: string; event: string }[] = [];
      const rec = (): DevLog => ({
        debug: (event: string) => { events.push({ level: 'debug', event }); },
        info: (event: string) => { events.push({ level: 'info', event }); },
        warn: (event: string) => { events.push({ level: 'warn', event }); },
        error: (event: string) => { events.push({ level: 'error', event }); },
        child: () => rec(),
        flush: () => Promise.resolve(),
      });
      const stage = new ConnectStage(root, oneClusterDecider('unused'), new FlakyLinkLock(), undefined, undefined, rec());
      await stage.poke();
      stage.stop();

      // The link LANDED via retry (not dropped): the wikilink is rendered…
      const md = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(md).toContain(`[[${apple.rel}|Apple]]`);
      // …a retry was logged for the transient timeout, and NO terminal link-error (the retry succeeded).
      expect(events.some((e) => e.event === 'connect.link-retry')).toBe(true);
      expect(events.some((e) => e.event === 'connect.link-error')).toBe(false);
    });
  });
});

describe.skipIf(!gitAvailable)('connectOne — metadata: type Property + tags on the node (SPEC-0025 META-2/3/4)', () => {
  it('writes the curated type/<kind> tag + normalized agent topic tags into the node', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
      await commitAll(root, 'seed');

      const tagger: ConnectDecider = async (set) => ({
        blockKey: set.blockKey,
        clusters: [
          {
            canonicalName: 'Steve Jobs',
            memberCandidateIds: set.candidates.map((c) => c.id),
            confidence: 0.95,
            tags: ['Topic/Machine Learning', 'startups'], // emergent, un-normalized — Connect normalizes
          },
        ],
        agent: { via: 'copilot', model: 'test' },
      });
      await connectOne(root, 'person|steve jobs', tagger);

      const md = await fs.readFile(path.join(root, 'entities/person/Steve Jobs.md'), 'utf8');
      expect(md).toContain('type: person'); // curated Property
      expect(md).toMatch(/tags: \[[^\]]*"type\/person"[^\]]*\]/); // deterministic curated core, always present
      expect(md).toContain('"topic/machine-learning"'); // agent tag, normalized (META-3)
      expect(md).toContain('"startups"');
      // provenance (META-10): the resolve audit records the tags it set
      const audit = await readResolveAudit(root);
      const resolved = audit
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((o) => o.event === 'resolved');
      expect(resolved.tags).toContain('type/person');
    });
  });

  it('always emits at least the deterministic type/<kind> tag, even with no agent tags', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedCandidate(root, 'organization', 'Apple', '01S1');
      await commitAll(root, 'seed');
      await connectOne(root, 'organization|apple', oneClusterDecider('Apple')); // no tags in verdict
      const md = await fs.readFile(path.join(root, 'entities/organization/Apple.md'), 'utf8');
      expect(md).toContain('tags: ["type/organization"]');
    });
  });
});

// ── Within-source claim dedup as Connect's post-Claims pass (SPEC-0016 CLAIMS-19) ────────────
describe.skipIf(!gitAvailable)('Connect within-source claim dedup (CLAIMS-19)', () => {
  const SRC = 'sources/2026/06/02/01SRCA';
  /** Seed a claim WITH provenance.derivedFrom (the within-source dedup group key). */
  async function seedClaimProv(
    root: string,
    subjectRel: string,
    statement: string,
    status: 'fact' | 'interpretation' | 'hypothesis',
    confidence: number,
    derivedFrom = SRC,
  ): Promise<string> {
    const id = ulid();
    const rel = path.join('claims', dateShard(id), `${id}.md`);
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(
      dest,
      renderClaimMd({ statement, status, confidence, mentions: ['evidence'] }, { id, subject: subjectRel, derivedFrom, createdAt: '2026-06-02T00:00:00Z' }),
      'utf8',
    );
    return rel;
  }
  const exists = (root: string, rel: string) => fs.access(path.join(root, rel)).then(() => true).catch(() => false);

  it('a ConnectStage drain collapses within-source duplicate claims and advances canonical', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const ada = await seedNode(root, 'person', 'Ada Lovelace', [SRC]);
      const bab = await seedNode(root, 'person', 'Charles Babbage', [SRC]);
      const REL = 'Ada Lovelace worked with Charles Babbage.';
      const a1 = await seedClaimProv(root, ada.rel, REL, 'fact', 0.9); // canonical (fact)
      const a2 = await seedClaimProv(root, ada.rel, 'ada lovelace   WORKED with charles babbage', 'hypothesis', 0.5); // dup of a1 (same subject)
      const b1 = await seedClaimProv(root, bab.rel, REL, 'interpretation', 0.8); // dup of a1 (cross-subject, same source)
      const sym = await seedClaimProv(root, ada.rel, 'Charles Babbage worked with Ada Lovelace.', 'fact', 0.9); // symmetric reword — must SURVIVE (CONNECT-20)
      await commitAll(root, 'seed entities + duplicate claims');

      // A bare drain (no candidates/links queued) still runs the post-Claims dedup sweep.
      const stage = new ConnectStage(root, oneClusterDecider('unused'), new Mutex(), undefined, undefined, undefined);
      await stage.poke();
      stage.stop();

      // Canonical (root working tree, after the ff-merge inside the pass) reflects the collapse.
      expect(await exists(root, a1)).toBe(true); // fact canonical kept
      expect(await exists(root, a2)).toBe(false); // same-subject dup dropped
      expect(await exists(root, b1)).toBe(false); // cross-subject dup dropped
      expect(await exists(root, sym)).toBe(true); // symmetric reword survives (deferred → CONNECT-20)

      // Ada's regenerated block lists the survivors (a1, sym), not the dropped a2.
      const adaMd = await fs.readFile(path.join(root, ada.rel), 'utf8');
      expect(adaMd).toContain(`[[${a1}]]`);
      expect(adaMd).toContain(`[[${sym}]]`);
      expect(adaMd).not.toContain(`[[${a2}]]`);
      expect(adaMd).toContain('id:'); // identity untouched (CLAIMS-11)
      // Babbage lost its only claim → placeholder block, no dangling link.
      const babMd = await fs.readFile(path.join(root, bab.rel), 'utf8');
      expect(babMd).not.toContain(`[[${b1}]]`);
    });
  });

  it('dedupClaimsOnce commits + advances when it collapses, and is a clean no-op otherwise', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const ada = await seedNode(root, 'person', 'Ada Lovelace', [SRC]);
      const REL = 'Pioneered the first published algorithm.';
      await seedClaimProv(root, ada.rel, REL, 'fact', 0.9);
      const dup = await seedClaimProv(root, ada.rel, REL, 'hypothesis', 0.4);
      await commitAll(root, 'seed');
      const headBefore = (await simpleGit(root).revparse(['HEAD'])).trim();

      const first = await dedupClaimsOnce(root);
      expect(first.committed).toBe(true);
      expect(first.dropped).toBe(1);
      expect(await exists(root, dup)).toBe(false);
      const headAfter = (await simpleGit(root).revparse(['HEAD'])).trim();
      expect(headAfter).not.toBe(headBefore); // canonical advanced

      // Idempotent: a second pass finds no dupes → no commit, no advance.
      const second = await dedupClaimsOnce(root);
      expect(second.committed).toBe(false);
      expect(second.dropped).toBe(0);
      expect((await simpleGit(root).revparse(['HEAD'])).trim()).toBe(headAfter);
    });
  });

  // REGRESSION (same class as connect.link-error): dedupClaimsOnce's canonical advance shared the
  // raw `merge --ff-only` blind spot — it must self-heal a stale `.git/index.lock` (ORCH-27) too.
  it('heals a stale index.lock when it advances a dedup (shares the linkOne fix)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const ada = await seedNode(root, 'person', 'Ada Lovelace', [SRC]);
      const REL = 'Pioneered the first published algorithm.';
      await seedClaimProv(root, ada.rel, REL, 'fact', 0.9);
      const dup = await seedClaimProv(root, ada.rel, REL, 'hypothesis', 0.4);
      await commitAll(root, 'seed');

      const lockPath = await resolveIndexLockPath(root);
      await fs.writeFile(lockPath, '', 'utf8');
      const stale = new Date(Date.now() - (GATE3_STALE_AGE_MS + 60_000));
      await fs.utimes(lockPath, stale, stale);

      // FAILS-BEFORE: throws on the stale lock. PASSES-AFTER: heals + commits the collapse.
      const report = await dedupClaimsOnce(root);
      expect(report.committed).toBe(true);
      expect(report.dropped).toBe(1);
      expect(await exists(root, dup)).toBe(false);
      expect(await fs.stat(lockPath).then(() => true).catch(() => false)).toBe(false); // healed
    });
  });
});

// ── Orphan-RAG linker (SPEC-0051 slice-2 "the prize") ─────────────────────────────────────────
describe.skipIf(!gitAvailable)('linkOrphansOnce — recover the degree-0 orphan tail via grounded retrieval', () => {
  it('links two co-mentioned orphans (shared derivedFrom source) and improves cohesion', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // Two entities pulled from the SAME focused source → co-mention evidence; one lonely entity.
      const a = await seedNode(root, 'person', 'Walt Disney', ['sources/film/01F']);
      const b = await seedNode(root, 'organization', 'Disney Studios', ['sources/film/01F']);
      const lonely = await seedNode(root, 'person', 'Nobody', ['sources/solo/01S']);
      await commitAll(root, 'seed three orphans');

      const before = cohesionFromFiles(
        await Promise.all([a, b, lonely].map(async (n) => ({ path: n.rel, body: await fs.readFile(path.join(root, n.rel), 'utf8') }))),
      );
      expect(before.orphanShare).toBe(1); // all three orphaned

      const res = await linkOrphansOnce(root);
      expect(res.committed).toBe(true);
      expect(res.linked).toBe(2); // a and b linked to each other; lonely had no evidence
      expect(res.links).toBe(2);

      const aMd = await fs.readFile(path.join(root, a.rel), 'utf8');
      const bMd = await fs.readFile(path.join(root, b.rel), 'utf8');
      const lonelyMd = await fs.readFile(path.join(root, lonely.rel), 'utf8');
      expect(aMd).toContain(`[[${b.rel}|Disney Studios]]`); // grounded discovered link
      expect(bMd).toContain(`[[${a.rel}|Walt Disney]]`);
      expect(lonelyMd).not.toContain(LINKS_BLOCK_START); // no evidence → stays orphan (don't-false-link)

      const after = cohesionFromFiles(
        await Promise.all([a, b, lonely].map(async (n) => ({ path: n.rel, body: await fs.readFile(path.join(root, n.rel), 'utf8') }))),
      );
      expect(after.orphanShare).toBeLessThan(before.orphanShare); // coverage improved
      expect(after.edges).toBe(1); // exactly the one real relation, NOT a hairball
      expect((await simpleGit(root).status()).isClean()).toBe(true); // ORCH-3: advance is clean
    });
  });

  it('is idempotent: a second pass over a now-linked tail is a byte-stable no-op', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedNode(root, 'person', 'Walt Disney', ['sources/film/01F']);
      await seedNode(root, 'organization', 'Disney Studios', ['sources/film/01F']);
      await commitAll(root, 'seed');

      expect((await linkOrphansOnce(root)).committed).toBe(true);
      const second = await linkOrphansOnce(root);
      expect(second.committed).toBe(false); // both now have degree → nothing to link
      expect(second.links).toBe(0);
    });
  });

  it('a BROAD shared source does NOT manufacture links (rarity weighting — anti-hairball)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // 12 entities all derived from one big dump source → each pair weight 1/11 ≈ 0.09 < 0.2 minScore.
      for (let i = 0; i < 12; i++) await seedNode(root, 'person', `Person ${i}`, ['sources/dump/01D']);
      await commitAll(root, 'seed a broad dump');

      const res = await linkOrphansOnce(root);
      expect(res.committed).toBe(false); // nobody linked — a 12-entity dump is not evidence of real relations
      expect(res.orphans).toBe(12);
    });
  });

  it('links on a shared topic/ tag when it is rare; skips when it is common', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // Two entities share a RARE topic tag (only they hold it) → linked. A third shares nothing.
      const a = await seedNode(root, 'person', 'Ada', ['sources/x/01X'], [], ['type/person', 'topic/computing']);
      const b = await seedNode(root, 'person', 'Charles', ['sources/y/01Y'], [], ['type/person', 'topic/computing']);
      await seedNode(root, 'person', 'Grace', ['sources/z/01Z'], [], ['type/person']);
      await commitAll(root, 'seed topic-tagged orphans');

      const res = await linkOrphansOnce(root);
      expect(res.linked).toBe(2);
      const aMd = await fs.readFile(path.join(root, a.rel), 'utf8');
      expect(aMd).toContain(`[[${b.rel}|Charles]]`); // shared rare topic → discovered link
      expect(aMd).not.toContain('Grace'); // shared the type/person tag only — NOT a relatedness signal
    });
  });

  it('does NOT touch nodes the link-promotion pass owns (relatesTo subjects are skipped)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // 'steve' carries a relatesTo hint → owned by linkOne (in readLinkQueue), so the orphan linker skips it
      // even though it shares a source with 'pal'. 'pal' has no hint → the orphan linker may link it.
      const steve = await seedNode(root, 'person', 'Steve', ['sources/co/01C']);
      const pal = await seedNode(root, 'person', 'Pal', ['sources/co/01C']);
      await seedClaimRelatesTo(root, steve.rel, 'Knows someone unknown.', ['Ghost']); // unresolved hint → steve stays in linkOne's domain
      await commitAll(root, 'seed a relatesTo-owned node + a free orphan');

      expect(await readLinkQueue(root)).toContain(steve.rel); // steve is linkOne's
      const res = await linkOrphansOnce(root);
      // steve is skipped (owned); pal is a no-relatesTo orphan but its only co-mention partner (steve) is
      // skipped from the candidate pool? No — skip only removes the ORPHAN from processing, not as a target.
      const steveMd = await fs.readFile(path.join(root, steve.rel), 'utf8');
      expect(steveMd).not.toContain(LINKS_BLOCK_START); // the orphan linker never wrote steve's block
      // pal was processed and linked to steve (a valid co-mention target); steve's own block is untouched.
      const palMd = await fs.readFile(path.join(root, pal.rel), 'utf8');
      if (res.committed) expect(palMd).toContain(`[[${steve.rel}|`);
    });
  });

  it('is a clean no-op on an empty vault (no entities)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await commitAll(root, 'empty');
      const res = await linkOrphansOnce(root);
      expect(res).toMatchObject({ orphans: 0, linked: 0, links: 0, committed: false });
    });
  });
});

// ── Set-aside recovery (OBS-17, Connect half — mirrors claims CLAIMS-20) ─────────────────────
describe.skipIf(!gitAvailable)('Connect set-aside recovery (OBS-17)', () => {
  const KEY = 'person|steve jobs';
  // Induce a poison set-aside block: a throwing decider, K attempts → set aside (CONNECT-14).
  async function seedSetAside(root: string, lock: Mutex): Promise<void> {
    await seedCandidate(root, 'person', 'Steve Jobs', '01S1');
    await commitAll(root, 'seed');
    const failing: ConnectDecider = async () => {
      throw new Error('boom');
    };
    for (let n = 0; n < DEFAULT_MAX_ATTEMPTS; n++) await connectOne(root, KEY, failing, lock, DEFAULT_MAX_ATTEMPTS);
  }

  it('lists a set-aside block (keyed by blockKey, with a human name), off the active queue', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      await seedSetAside(root, lock);

      expect(await readConnectQueue(root)).toHaveLength(0); // set aside → not in the active queue
      const items = await listConnectSetAsideItems(root);
      expect(items).toHaveLength(1);
      expect(items[0].blockKey).toBe(KEY);
      expect(items[0].name).toBe('Steve Jobs'); // the candidate's spelling, not the normalized key
      expect(items[0].failures).toBe(DEFAULT_MAX_ATTEMPTS);
    });
  });

  it('retry re-enqueues the block and clears it from the set-aside list (idempotent)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      await seedSetAside(root, lock);

      await retryConnectItem(root, KEY, lock);
      expect(await listConnectSetAsideItems(root)).toHaveLength(0); // reopened → no longer set aside
      expect((await readConnectQueue(root)).map((s) => s.blockKey)).toContain(KEY); // back in the queue
      // Idempotent in the read-outside/act-under-lock window: a second retry is harmless.
      await retryConnectItem(root, KEY, lock);
      expect((await readConnectQueue(root)).map((s) => s.blockKey)).toContain(KEY);
    });
  });

  it('dismiss retires the block permanently — off BOTH the queue and the set-aside list (idempotent)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      await seedSetAside(root, lock);

      await dismissConnectItem(root, KEY, lock);
      expect(await listConnectSetAsideItems(root)).toHaveLength(0); // dismissed ≠ recoverable
      expect(await readConnectQueue(root)).toHaveLength(0); // never re-queued
      await dismissConnectItem(root, KEY, lock); // idempotent
      expect(await readConnectQueue(root)).toHaveLength(0);
    });
  });

  // The GLUED recovery path that pipelineControlForActive composes (OBS-17 e2e, #55 done-bar):
  // poison block → surfaces in the Status-view union → the stage-agnostic planner resolves the
  // renderer's blockKey server-side → my primitive runs → block re-derives (retry) / retires (dismiss).
  // Drives the exact composition from #162's pipeline dispatch, deterministically (no copilot).
  it('end-to-end: poison block surfaces in status, then Retry re-derives and Dismiss retires (#55)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      await seedSetAside(root, lock);

      // 1. Surfaces in the Status view (the assembler maps connect items via toSetAsideViews(_, 'connect')).
      const items = await listConnectSetAsideItems(root);
      const views = toSetAsideViews(
        items.map((i) => ({ itemId: i.blockKey, name: i.name, failures: i.failures, rounds: i.rounds })),
        'connect',
      );
      expect(views).toEqual([{ stage: 'connect', itemId: KEY, name: 'Steve Jobs', reason: `set aside after ${DEFAULT_MAX_ATTEMPTS} failed attempts` }]);

      // 2. Server-side resolve the renderer's itemId (blockKey) → handle, via the stage-agnostic planner.
      const targets = items.map((i) => ({ id: i.blockKey, handle: i.blockKey, label: i.name }));
      const plan = planSetAsideAction(targets, { stage: 'connect', action: 'retry', itemId: KEY });
      expect('handle' in plan && plan.handle).toBe(KEY);

      // 3. Retry → block re-derives (back in the active queue), off the set-aside list.
      if ('handle' in plan) await retryConnectItem(root, plan.handle, lock);
      expect((await readConnectQueue(root)).map((s) => s.blockKey)).toContain(KEY);
      expect(await listConnectSetAsideItems(root)).toHaveLength(0);

      // A renderer-supplied itemId NOT in the live list resolves to a no-op error (trust boundary).
      expect('error' in planSetAsideAction(targets, { stage: 'connect', action: 'retry', itemId: 'person|ghost' })).toBe(true);
    });
  });
});

// REVIEW-18 / CONNECT-21 — a disambiguation verdict is a DURABLE per-pair decision; a decided pair is
// never re-asked. The Principal kept getting the SAME "are these the same?" review (Leavenworth, Paris,
// Gary) on every new mention because the verdict was consumed per-round and forgotten.
describe.skipIf(!gitAvailable)('REVIEW-18 / CONNECT-21 — durable disambiguation decisions', () => {
  // Two existing same-key nodes (same name → same blockKey, distinct rels/ids) — the "two Leavenworths".
  async function seedNodeAt(root: string, rel: string, kind: string, name: string): Promise<{ id: string; rel: string }> {
    const id = ulid();
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(
      dest,
      renderEntityNode({ id, kind, name, confidence: 0.9, aliases: [id], derivedFrom: ['sources/x/01SX'], resolvedFrom: [], tags: [], createdAt: '2026-05-30T00:00:00Z', updatedAt: '2026-05-30T00:00:00Z' }),
      'utf8',
    );
    return { id, rel };
  }
  // A decider that resolves the block's candidates into existing node A, AND raises a "same?" review
  // about the existing pair — i.e. the recurring re-ask. The stage suppresses it once the pair is decided.
  function pairReviewDecider(pair: [string, string], foldIntoId: string): ConnectDecider {
    return async (set: CandidateSet): Promise<ConnectDecision> => ({
      blockKey: set.blockKey,
      clusters: [{ canonicalName: 'Leavenworth', memberCandidateIds: set.candidates.map((c) => c.id), existingNodeId: foldIntoId, confidence: 0.9 }],
      reviews: [{ question: 'Is Leavenworth (the company) the same as Leavenworth (the WA town)?', detail: 'Two same-named entities.', pair }],
      agent: { via: 'copilot', model: 'test' },
    });
  }

  it("a 'distinct' verdict suppresses the re-raise on a fresh mention of the same pair (CONNECT-21)", async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const a = await seedNodeAt(root, 'entities/organization/leavenworth.md', 'organization', 'Leavenworth');
      const b = await seedNodeAt(root, 'entities/organization/leavenworth-wa.md', 'organization', 'Leavenworth');
      await seedCandidate(root, 'organization', 'Leavenworth', '01SRC1');
      await commitAll(root, 'two Leavenworths + a fresh mention');
      const key = 'organization|leavenworth';
      const decider = pairReviewDecider([a.id, b.id], a.id);

      // Pass 1: undecided pair → the review IS raised (parked).
      await connectOne(root, key, decider);
      const open1 = await findOpenReviews(root);
      expect(open1).toHaveLength(1);
      expect(open1[0].raisedBy.markerKey.pairA).toBeDefined(); // carries the pair for the answer to record

      // The Principal answers "different" → durable distinct-from decision recorded at answer-time.
      await answerReview(root, new Mutex(), open1[0].id, { verdict: 'reject' });
      const decisions = await readDisambiguationDecisions(root);
      expect(decisionForPair(decisions, a.id, b.id)?.verdict).toBe('distinct');

      // A FRESH mention of the same name re-blocks the key…
      await seedCandidate(root, 'organization', 'Leavenworth', '01SRC2');
      await commitAll(root, 'a later source mentions Leavenworth again');

      // Pass 2: the decider would re-raise the SAME pair, but CONNECT-21 consults the decision and
      // SUPPRESSES it → no NEW open review (the queue converges instead of spamming).
      await connectOne(root, key, decider);
      const open2 = await findOpenReviews(root);
      expect(open2).toHaveLength(0); // the decided pair is never re-asked
    });
  });

  it('an undecided, never-before-seen pair STILL raises (the memory is per-pair)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const a = await seedNodeAt(root, 'entities/organization/leavenworth.md', 'organization', 'Leavenworth');
      const b = await seedNodeAt(root, 'entities/organization/leavenworth-wa.md', 'organization', 'Leavenworth');
      const c = await seedNodeAt(root, 'entities/organization/leavenworth-co.md', 'organization', 'Leavenworth');
      await seedCandidate(root, 'organization', 'Leavenworth', '01SRC1');
      await commitAll(root, 'three Leavenworths');
      const key = 'organization|leavenworth';

      // Decide (a,b) distinct first.
      await connectOne(root, key, pairReviewDecider([a.id, b.id], a.id));
      const open = await findOpenReviews(root);
      await answerReview(root, new Mutex(), open[0].id, { verdict: 'reject' });

      // A review about a DIFFERENT, undecided pair (a,c) still raises — only (a,b) is settled.
      await seedCandidate(root, 'organization', 'Leavenworth', '01SRC2');
      await commitAll(root, 'fresh mention');
      await connectOne(root, key, pairReviewDecider([a.id, c.id], a.id));
      const openAfter = await findOpenReviews(root);
      expect(openAfter).toHaveLength(1); // the never-decided pair (a,c) is asked
      expect(decisionForPair(await readDisambiguationDecisions(root), a.id, c.id)).toBeUndefined();
    });
  });

  it("a 'same' (confirm) verdict is recorded durably and likewise not re-asked", async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const a = await seedNodeAt(root, 'entities/organization/leavenworth.md', 'organization', 'Leavenworth');
      const b = await seedNodeAt(root, 'entities/organization/leavenworth-wa.md', 'organization', 'Leavenworth');
      await seedCandidate(root, 'organization', 'Leavenworth', '01SRC1');
      await commitAll(root, 'two Leavenworths');
      const key = 'organization|leavenworth';
      const decider = pairReviewDecider([a.id, b.id], a.id);

      await connectOne(root, key, decider);
      const open = await findOpenReviews(root);
      await answerReview(root, new Mutex(), open[0].id, { verdict: 'confirm' }); // SAME
      expect(decisionForPair(await readDisambiguationDecisions(root), a.id, b.id)?.verdict).toBe('same');

      await seedCandidate(root, 'organization', 'Leavenworth', '01SRC2');
      await commitAll(root, 'fresh mention');
      await connectOne(root, key, decider);
      expect(await findOpenReviews(root)).toHaveLength(0); // a decided-same pair is not re-asked either
    });
  });
});

describe.skipIf(!gitAvailable)('SPEC-0050 Directives slice-1 — answered disambiguation survives ULID rebirth (DIR-2/3/4/8)', () => {
  // Seed a same-key entity node with an explicit id (so the test can rebirth it under a NEW ULID).
  async function seedNode(root: string, rel: string, kind: string, name: string): Promise<{ id: string; rel: string }> {
    const id = ulid();
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(
      dest,
      renderEntityNode({ id, kind, name, confidence: 0.9, aliases: [id], derivedFrom: ['sources/x/01SX'], resolvedFrom: [], tags: [], createdAt: '2026-05-30T00:00:00Z', updatedAt: '2026-05-30T00:00:00Z' }),
      'utf8',
    );
    return { id, rel };
  }
  // A decider that folds the block's candidates into `foldIntoId` AND raises a "same?" review about the
  // existing pair — i.e. the recurring re-ask the directive must settle.
  function pairReviewDecider(pair: [string, string], foldIntoId: string): ConnectDecider {
    return async (set: CandidateSet): Promise<ConnectDecision> => ({
      blockKey: set.blockKey,
      clusters: [{ canonicalName: 'Disney', memberCandidateIds: set.candidates.map((c) => c.id), existingNodeId: foldIntoId, confidence: 0.9 }],
      reviews: [{ question: 'Is this Disney the same organization as the other Disney?', detail: 'Two same-named orgs.', pair }],
      agent: { via: 'copilot', model: 'test' },
    });
  }

  // THE BUG: the legacy decision is keyed by entity ULIDs, which are reborn on a re-derive / Full Replay
  // (entities/ is purged + rebuilt), so an answered "Disney is one org" stopped matching and the identical
  // review re-raised. SPEC-0050 graduates the answer to a DIRECTIVE keyed on the STABLE block identity
  // (`organization|disney`), which is content-derived and survives the rebirth — so the question stays
  // settled. This is the hard QD-2 regression (must not re-raise across a replay).
  it('a directive keeps an answered merge settled after the entity ULIDs are reborn (replay/re-derive) — DIR-4', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const key = 'organization|disney';

      // 1. Two same-key Disney nodes; the decider asks "same?"; the Principal answers SAME (merge).
      const a = await seedNode(root, 'entities/organization/disney.md', 'organization', 'Disney');
      const b = await seedNode(root, 'entities/organization/disney-co.md', 'organization', 'Disney');
      await seedCandidate(root, 'organization', 'Disney', '01SRC1');
      await commitAll(root, 'two Disneys + a mention');
      await connectOne(root, key, pairReviewDecider([a.id, b.id], a.id));
      const open = await findOpenReviews(root);
      expect(open).toHaveLength(1);
      await answerReview(root, new Mutex(), open[0].id, { verdict: 'confirm' });

      // The answer graduated to a DURABLE DIRECTIVE keyed on the STABLE block identity (not the ULIDs).
      expect(directiveForIdentity(await readDisambiguationDirectives(root), key)?.verdict).toBe('same');

      // 2. Simulate the re-derive/replay: the entities are reborn with NEW ULIDs (old nodes purged).
      await fs.rm(path.join(root, a.rel));
      await fs.rm(path.join(root, b.rel));
      const a2 = await seedNode(root, 'entities/organization/disney.md', 'organization', 'Disney');
      const b2 = await seedNode(root, 'entities/organization/disney-co.md', 'organization', 'Disney');
      await seedCandidate(root, 'organization', 'Disney', '01SRC2');
      await commitAll(root, 'replay rebirth: new ULIDs + a fresh mention');

      // CONTROL — the legacy pair-keyed memory is BLIND to the reborn ULIDs (exactly the bug):
      expect(decisionForPair(await readDisambiguationDecisions(root), a2.id, b2.id)).toBeUndefined();

      // 3. The decider re-raises on the NEW pair, but the DIRECTIVE (block identity) suppresses it.
      await connectOne(root, key, pairReviewDecider([a2.id, b2.id], a2.id));
      expect(await findOpenReviews(root)).toHaveLength(0); // settled by directive — never re-asked (DIR-4)
    });
  });

  // The cross-source half of the same regression, on the SAME entity generation: an entirely fresh
  // same-name source must not re-raise once a directive settles the identity, even for a pair the
  // pair-keyed store never recorded.
  it('a directive auto-resolves a never-pair-decided disambiguation on a new same-name source (DIR-3)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const key = 'organization|disney';
      const a = await seedNode(root, 'entities/organization/disney.md', 'organization', 'Disney');
      const b = await seedNode(root, 'entities/organization/disney-co.md', 'organization', 'Disney');
      await seedCandidate(root, 'organization', 'Disney', '01SRC1');
      await commitAll(root, 'two Disneys');
      // Answer the (a,b) question SAME → directive on the block identity.
      await connectOne(root, key, pairReviewDecider([a.id, b.id], a.id));
      const open = await findOpenReviews(root);
      await answerReview(root, new Mutex(), open[0].id, { verdict: 'confirm' });
      expect(directiveForIdentity(await readDisambiguationDirectives(root), key)?.verdict).toBe('same');

      // A THIRD same-name node arrives (a new source). The decider asks about the never-decided (a,c)
      // pair — pair-keyed memory would re-ask (see REVIEW-18 'undecided pair STILL raises'), but the
      // block-identity directive marks the whole question settled → suppressed.
      const c = await seedNode(root, 'entities/organization/disney-3.md', 'organization', 'Disney');
      await seedCandidate(root, 'organization', 'Disney', '01SRC2');
      await commitAll(root, 'a third Disney from a new source');
      expect(decisionForPair(await readDisambiguationDecisions(root), a.id, c.id)).toBeUndefined();
      await connectOne(root, key, pairReviewDecider([a.id, c.id], a.id));
      expect(await findOpenReviews(root)).toHaveLength(0); // settled by directive (DIR-3)
    });
  });
});

// #507 PERF-E3: connect's idle sweep did whole-vault work (readLinkQueue's O(N) claims/entities walk +
// linkOne/linkOrphansOnce/dedupClaimsOnce's own worktree-ensure+reads) unconditionally UNDER THE LOCK,
// every 30s, forever — even on an idle vault where nothing had changed since the last pass. That's the
// mechanism behind "hangs during ingest" and capture latency spikes (captures queue behind the sweep).
describe.skipIf(!gitAvailable)('#507 connect sweep off-lock (HEAD-gate + off-lock byte-stable prefilter)', () => {
  it('linkOneWouldChange predicts exactly what linkOne would do: true before, false after (idempotent)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedClaimRelatesTo(root, steve.rel, 'Co-founded Apple.', ['Apple']);
      await commitAll(root, 'seed');

      expect(await linkOneWouldChange(root, steve.rel)).toBe(true); // a real link is pending
      await linkOne(root, steve.rel);
      expect(await linkOneWouldChange(root, steve.rel)).toBe(false); // now byte-stable — nothing to do
      // linkOne agrees: calling it again is a confirmed no-op (regression-proof the two never disagree).
      expect((await linkOne(root, steve.rel)).changed).toBe(false);
    });
  });

  it('linkOneWouldChange is a safe (never-hanging) no-op for a since-merged/gone node', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      expect(await linkOneWouldChange(root, 'entities/person/nobody.md')).toBe(false);
    });
  });

  // Fake-clock-equivalent HEAD-gate proof (AC: "linkOne not invoked when HEAD unchanged"): the FIRST
  // sweep on a vault with pending link work runs the tail for real (and, since it fully processed the
  // queue it saw, immediately caches the fresh post-commit HEAD as converged); every sweep AFTER that,
  // with a truly unchanged canonical HEAD, is skipped outright — 0 additional readLinkQueue/linkOne/
  // linkOrphansOnce/dedupClaimsOnce calls, proven via the tail-run/skip counters, not timing (deterministic).
  it('HEAD-gate: the link/orphan/dedup tail runs once, then is SKIPPED entirely while HEAD stays unchanged', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedClaimRelatesTo(root, steve.rel, 'Co-founded Apple.', ['Apple']);
      await commitAll(root, 'seed');

      const stage = new ConnectStage(root, oneClusterDecider('unused'), new Mutex());
      await stage.poke(); // first sweep: real work (converges the link) → tail ran, then cached
      expect(stage.connectSweepTailStats()).toEqual({ skipped: 0, ran: 1 });
      expect((await fs.readFile(path.join(root, steve.rel), 'utf8'))).toContain('[[');

      await stage.poke(); // second sweep, HEAD unchanged (nothing else committed) → tail SKIPPED
      expect(stage.connectSweepTailStats()).toEqual({ skipped: 1, ran: 1 });
      await stage.poke(); // idempotent — stays skipped indefinitely while idle
      expect(stage.connectSweepTailStats()).toEqual({ skipped: 2, ran: 1 });
    });
  });

  it('HEAD-gate: a NEW commit (HEAD moves) makes the next sweep re-run the tail, not skip it', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const steve = await seedNode(root, 'person', 'Steve Jobs', ['sources/a/01SA']);
      await seedNode(root, 'organization', 'Apple', ['sources/b/01SB']);
      await seedClaimRelatesTo(root, steve.rel, 'Co-founded Apple.', ['Apple']);
      await commitAll(root, 'seed');

      const stage = new ConnectStage(root, oneClusterDecider('unused'), new Mutex());
      await stage.poke();
      expect(stage.connectSweepTailStats()).toEqual({ skipped: 0, ran: 1 });

      // An unrelated capture lands directly on canonical (simulating another writer's commit).
      await captureToInbox(root, 'test', [{ kind: 'text', text: 'unrelated capture' }], Date.now());

      await stage.poke(); // HEAD moved → the gate must NOT skip (fails-before: a naive time-based
      // or one-shot gate would wrongly cache the skip forever regardless of new canonical activity)
      expect(stage.connectSweepTailStats()).toEqual({ skipped: 0, ran: 2 });
    });
  });

  // #507 item 2 (off-lock byte-stable prefilter) — the AC's "lock-contention test: a concurrent capture
  // completes without waiting for [the link pass]". Proven deterministically (not via timing, which
  // would be flaky under CI load): with N already-linked nodes still sitting in the derived link queue
  // (readLinkQueue doesn't shrink just because a node is linked — it's a pure function of `relatesTo`
  // claims), the OLD code took the shared lock once per node just to discover "nothing to do". The fix
  // means the lock is NEVER taken for an already-stable node — so a concurrent capture queued behind
  // this loop waits behind ZERO of them, not N.
  it('off-lock prefilter: an already-converged node NEVER takes the shared lock again (0 "connect:link" holds)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const NODE_COUNT = 5;
      const nodes: { id: string; rel: string }[] = [];
      for (let i = 0; i < NODE_COUNT; i++) {
        const org = await seedNode(root, 'organization', `Org ${i}`, [`sources/o${i}/01S`]);
        const person = await seedNode(root, 'person', `Person ${i}`, [`sources/p${i}/01S`]);
        await seedClaimRelatesTo(root, person.rel, `Works at Org ${i}.`, [`Org ${i}`]);
        nodes.push(person);
        void org;
      }
      await commitAll(root, 'seed 5 person/org pairs');

      const lock = new Mutex();
      const stage = new ConnectStage(root, oneClusterDecider('unused'), lock);
      await stage.poke(); // converges all 5 — the tail actually ran and did real lock-held work
      expect(stage.connectSweepTailStats()).toEqual({ skipped: 0, ran: 1 });
      for (const n of nodes) expect(await linkOneWouldChange(root, n.rel)).toBe(false); // all stable now

      // Force the gate open again (HEAD must differ from the last converged point) without touching
      // any of the 5 nodes, so this pass exercises the PER-NODE prefilter in isolation from item 1's
      // whole-tail gate.
      await captureToInbox(root, 'test', [{ kind: 'text', text: 'unrelated capture' }], Date.now());

      const runCalls: string[] = [];
      const realRun = lock.run.bind(lock);
      lock.run = ((fn: () => Promise<unknown>, label?: string) => {
        if (label) runCalls.push(label);
        return realRun(fn, label);
      }) as typeof lock.run;

      await stage.poke();
      expect(stage.connectSweepTailStats()).toEqual({ skipped: 0, ran: 2 }); // gate DID run the tail…
      expect(runCalls.filter((l) => l === 'connect:link')).toEqual([]); // …but took the lock for NONE of the 5 stable nodes
    });
  });
});

// SPEC-0061 T1 / ENG-9 (#539 QA fast-follow) — end-to-end proof for readCandidates/readEntityNodes:
// these two fuse a parse step into the retired walker (unlike findEntityFiles's pure listing), so a
// malformed file must be excluded by the PARSE catch, not just walked and handed back raw. Pure fs,
// no git needed.
describe('readCandidates / readEntityNodes — a malformed file is skipped end-to-end, never throws (#539 QA fast-follow)', () => {
  it('readCandidates: a malformed candidate JSON file is excluded; the well-formed sibling is returned', async () => {
    const root = await makeTempDir('kb-readcandidates-');
    try {
      await fs.mkdir(path.join(root, 'candidates'), { recursive: true });
      const good: Candidate = { id: ulid(), sourceId: 'SRC1', kind: 'person', name: 'Ada Lovelace', confidence: 0.9, mentions: ['Ada'] };
      await fs.writeFile(path.join(root, 'candidates', `${good.id}.json`), JSON.stringify(good), 'utf8');
      await fs.writeFile(path.join(root, 'candidates', 'broken.json'), 'not valid json at all {{{', 'utf8');

      const candidates = await readCandidates(root); // no throw on the malformed sibling — the assertion
      expect(candidates.map((c) => c.id)).toEqual([good.id]);
    } finally {
      await rmTempDir(root);
    }
  });

  it('readCandidates: well-formed JSON that fails Candidate shape validation is also excluded, not thrown', async () => {
    const root = await makeTempDir('kb-readcandidates-');
    try {
      await fs.mkdir(path.join(root, 'candidates'), { recursive: true });
      await fs.writeFile(path.join(root, 'candidates', 'shapeless.json'), JSON.stringify({ notACandidate: true }), 'utf8');
      await expect(readCandidates(root)).resolves.toEqual([]);
    } finally {
      await rmTempDir(root);
    }
  });

  it('readEntityNodes: a malformed entity file (no frontmatter) is excluded; the well-formed sibling is returned', async () => {
    const root = await makeTempDir('kb-readentitynodes-');
    try {
      const goodRel = entityFileRel('person', 'Ada Lovelace', ulid());
      await fs.mkdir(path.dirname(path.join(root, goodRel)), { recursive: true });
      await fs.writeFile(
        path.join(root, goodRel),
        renderEntityNode({
          id: ulid(),
          kind: 'person',
          name: 'Ada Lovelace',
          confidence: 0.9,
          aliases: [],
          tags: [],
          derivedFrom: [],
          resolvedFrom: [],
          createdAt: '2026-06-02T00:00:00Z',
          updatedAt: '2026-06-02T00:00:00Z',
        }),
        'utf8',
      );
      await fs.mkdir(path.join(root, 'entities', 'concept'), { recursive: true });
      await fs.writeFile(path.join(root, 'entities', 'concept', 'broken.md'), 'not a valid entity — no frontmatter\n', 'utf8');

      const nodes = await readEntityNodes(root); // no throw on the malformed sibling — the assertion
      expect(nodes.map((n) => n.rel)).toEqual([goodRel]);
    } finally {
      await rmTempDir(root);
    }
  });
});
