// Claims stage tests (SPEC-0016 CLAIMS). Real FS + git + worktrees against a throwaway temp
// vault (TEST-18); the deciders are injected so nothing shells out to copilot (TEST-2). The
// real pipeline is capture → archive → decompose (candidates) → CONNECT (entities) → CLAIMS
// (SPEC-0021 STAGING-5); these tests exercise the Claims tail with a seeded entity graph
// (Connect's output stood in via renderEntityNode) rather than running Connect end-to-end.
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { captureToInbox } from './ingest';
import { archiveOne, readQueue } from './orchestrator';
import { deterministicDecider } from './archivist';
import { Mutex } from './stageLock';
import { DecomposeStage } from './decomposeStage';
import type { DecomposeDecider } from './decomposeAgent';
import { renderEntityNode, entityFileRel } from './connectDoc';
import { ulid } from './ulid';
import { claimsOne, readClaimsQueue, readClaimsState, findEntityFiles, parseEntityNode, parseClaimBacklink, ClaimsStage, retryClaimsItem, dismissClaimsItem, listSetAsideItems, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_REVIEW_ROUNDS } from './claimsStage';
import { renderClaimMd } from './claimDoc';
import { recordCorrectionDirective } from './directives';
import type { ClaimsDecider } from './claimsAgent';
import type { ClaimDecision, ClaimsDecision } from './claims';
import { findOpenReviews, answerReview, getReview } from './reviewStore';

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

/** A decompose decider that mints the given entity names as candidates (kind=person). Used only
 *  by the shared-lock concurrency test, which runs Decompose alongside Claims. */
function decompDeciderFor(names: string[]): DecomposeDecider {
  return async (input) => ({
    sourceId: input.sourceId,
    entities: names.map((name) => ({ kind: 'person', name, confidence: 0.8, mentions: [name] })),
    agent: { via: 'copilot', model: 'test' },
  });
}

/** A claims decider that returns a fixed claim set (+ optional signals). */
function claimsDeciderFor(claims: ClaimDecision[], signals?: ClaimsDecision['signals']): ClaimsDecider {
  return async (input) => ({ entityId: input.entityId, claims, ...(signals ? { signals } : {}), agent: { via: 'copilot', model: 'test' } });
}

const aClaim = (over: Partial<ClaimDecision> = {}): ClaimDecision => ({
  statement: 'Owns the Q3 budget.',
  status: 'interpretation',
  confidence: 0.7,
  mentions: ['Steve owns the Q3 budget'],
  ...over,
});

/**
 * Seed resolved entity nodes directly (standing in for CONNECT's output, CONNECT-7/8) and commit
 * them to canonical, so Claims has entities to attach to. Decompose now writes candidates, not
 * entities (STAGING-5), so the Claims fixture seeds the post-resolution graph itself. Distinct
 * names — and repeated names across sources — each get their own node (entityFileRel suffixes a
 * within-vault collision), matching a graph that may hold un-merged same-name nodes.
 */
async function seedEntities(root: string, srcRel: string, names: string[]): Promise<string[]> {
  const now = new Date().toISOString();
  const taken = new Set(await findEntityFiles(root)); // existing nodes in THIS vault
  const rels: string[] = [];
  for (const name of names) {
    const id = ulid();
    const rel = entityFileRel('person', name, id, taken);
    taken.add(rel);
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(
      dest,
      renderEntityNode({
        id,
        kind: 'person',
        name,
        confidence: 0.8,
        aliases: [id],
        derivedFrom: [srcRel],
        resolvedFrom: [],
        tags: [],
        createdAt: now,
        updatedAt: now,
        agent: { via: 'copilot', model: 'test' },
      }),
      'utf8',
    );
    rels.push(rel);
  }
  const git = simpleGit(root);
  await git.raw('add', '-A');
  await git.commit('test: seed resolved entities');
  return rels;
}

/** Capture → archive a source, then seed entity nodes for it; return source + entity rels. */
async function setup(root: string, text: string, names: string[]): Promise<{ srcRel: string; entityRels: string[] }> {
  const srcRel = await archiveText(root, text);
  const entityRels = await seedEntities(root, srcRel, names);
  return { srcRel, entityRels };
}

/** Capture → archive ONE text source; return its repo-relative source dir. */
async function archiveText(root: string, text: string): Promise<string> {
  await captureToInbox(root, 'in-app-panel', [{ kind: 'text', text }]);
  const q = await readQueue(root);
  return archiveOne(root, q[q.length - 1], deterministicDecider);
}

/**
 * Seed ONE resolved entity node whose provenance spans MULTIPLE sources — Connect's merge output
 * (CONNECT-7/8), the post-merge graph a real Connect run produces. Commits it to canonical so Claims
 * has a multi-source entity to attach to. The CLAIMS-21 data-loss fixture.
 */
async function seedMergedEntity(root: string, name: string, srcRels: string[]): Promise<string> {
  const now = new Date().toISOString();
  const id = ulid();
  const rel = entityFileRel('person', name, id, new Set(await findEntityFiles(root)));
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(
    dest,
    renderEntityNode({
      id,
      kind: 'person',
      name,
      confidence: 0.9,
      aliases: [id],
      derivedFrom: srcRels,
      resolvedFrom: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
      agent: { via: 'copilot', model: 'test' },
    }),
    'utf8',
  );
  const git = simpleGit(root);
  await git.raw('add', '-A');
  await git.commit('test: seed Connect-merged entity (multi-source)');
  return rel;
}

async function readClaimFiles(root: string): Promise<string[]> {
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
      else if (e.name.endsWith('.md')) out.push(await fs.readFile(p, 'utf8'));
    }
  }
  await walk(path.join(root, 'claims'));
  return out;
}

describe('parseEntityNode (CLAIMS-5/21 — resolves an entity to ALL its sources)', () => {
  it('extracts kind, name, and the single source, handling quoted scalars', () => {
    const md = '---\nid: 01J\nkind: person\nname: "Q3: budget"\nconfidence: 0.9\nprovenance:\n  derivedFrom: ["sources/2026/05/30/01JSRC"]\n---\n\n# Q3: budget\n';
    expect(parseEntityNode(md)).toEqual({ kind: 'person', name: 'Q3: budget', sources: ['sources/2026/05/30/01JSRC'] });
  });
  it('extracts EVERY source of a Connect-merged entity, not just derivedFrom[0] (CLAIMS-21)', () => {
    const md = '---\nid: 01J\nkind: person\nname: Grace Hopper\nprovenance:\n  derivedFrom: ["sources/2026/05/30/01A", "sources/2026/05/31/01B"]\n---\n\n# Grace Hopper\n';
    expect(parseEntityNode(md).sources).toEqual(['sources/2026/05/30/01A', 'sources/2026/05/31/01B']);
  });
  it('throws when kind/name are missing', () => {
    expect(() => parseEntityNode('---\nid: x\n---\n')).toThrow(/kind\/name/);
  });
  it('throws when provenance.derivedFrom is missing', () => {
    expect(() => parseEntityNode('---\nkind: person\nname: Steve\n---\n')).toThrow(/derivedFrom/);
  });
});

describe('parseClaimBacklink ↔ renderClaimMd round-trip (CLAIMS-9/21 — block regen reads the claim file)', () => {
  // GUARD against the format coupling KB-QD flagged: `parseClaimBacklink` reconstructs a block
  // back-link from a claim FILE that `renderClaimMd` wrote. A future render-format tweak that this
  // parser doesn't track would silently break union block regen — so render → parse → assert fields.
  const meta = (over: Partial<Parameters<typeof renderClaimMd>[1]> = {}) => ({
    id: '01JCLAIMROUNDTRIP000000000',
    subject: 'entities/2026/05/30/01JENTITY.md',
    derivedFrom: 'sources/2026/05/30/01JSOURCE',
    createdAt: '2026-05-30T12:00:00.000Z',
    agent: { via: 'copilot' as const, model: 'test' },
    ...over,
  });

  it('round-trips statement, status, confidence, and single-source provenance', () => {
    const m = meta();
    const claim: ClaimDecision = { statement: 'Owns the Q3 budget.', status: 'fact', confidence: 0.9, mentions: ['Steve owns Q3'] };
    const md = renderClaimMd(claim, m);
    const claimPath = 'claims/2026/05/30/01JCLAIMROUNDTRIP000000000.md';

    const link = parseClaimBacklink(md, claimPath, m.subject);
    expect(link).toEqual({
      claimPath,
      statement: 'Owns the Q3 budget.',
      status: 'fact',
      confidence: 0.9,
      source: m.derivedFrom, // VAULT-13: the claim's single source, parsed from provenance.derivedFrom
    });
  });

  it("reads the statement, not the body's `Source:` citation line (the exact coupling that could drift)", () => {
    // renderClaimMd appends a `Source: [[…]]` line to the body when derivedFrom is present — the parser
    // must skip it and return the actual statement. A multi-space/whitespace statement is oneLine'd.
    const m = meta();
    const claim: ClaimDecision = { statement: 'Led   the\n  Apollo program', status: 'interpretation', confidence: 0.5, mentions: [] };
    const md = renderClaimMd(claim, m);
    expect(md).toContain('Source: [['); // precondition: the citation line the parser must not mistake for the statement

    const link = parseClaimBacklink(md, 'claims/x.md', m.subject);
    expect(link?.statement).toBe('Led the Apollo program'); // collapsed, and NOT the `Source:` line
    expect(link?.status).toBe('interpretation');
    expect(link?.confidence).toBe(0.5);
  });

  it('returns null when the claim is about a DIFFERENT entity (subject guard for the union scan)', () => {
    const m = meta();
    const md = renderClaimMd({ statement: 'x', status: 'fact', confidence: 1, mentions: [] }, m);
    expect(parseClaimBacklink(md, 'claims/x.md', 'entities/2026/05/30/01JOTHER.md')).toBeNull();
  });
});

describe.skipIf(!gitAvailable)('readClaimsQueue (CLAIMS-2/16)', () => {
  it('lists entity nodes that have no terminal claims marker', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'call Steve re: Q3 budget', ['Steve', 'Q3 budget']);
      expect(entityRels).toHaveLength(2);
      expect(await readClaimsQueue(root)).toHaveLength(2); // both entities await claims
    });
  });
});

describe.skipIf(!gitAvailable)('claimsOne writes claims with whole-source provenance (CLAIMS-1/5/6/15)', () => {
  it('writes claim files (subject→entity, derivedFrom→whole source) and ff-advances a clean tree', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { srcRel, entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      const res = await claimsOne(root, entityRels[0], claimsDeciderFor([aClaim()]));

      expect(res.ok).toBe(true);
      expect(res.claimIds).toHaveLength(1);
      const claims = await readClaimFiles(root);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toContain(`subject: ${entityRels[0]}`); // single-subject link (CLAIMS-6)
      expect(claims[0]).toContain(`derivedFrom: ["${srcRel}"]`); // CLAIMS-5 whole source
      expect(claims[0]).toContain('status: interpretation');

      expect((await simpleGit(root).status()).isClean()).toBe(true); // ORCH-3 / CLAIMS-15
    });
  });

  it('feeds the agent the WHOLE source text, not just the node spans (CLAIMS-5)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const text = 'Steve owns the Q3 budget. He also visited the Austin site on the 14th.';
      const { entityRels } = await setup(root, text, ['Steve']);
      let seen = '';
      const spy: ClaimsDecider = async (input) => {
        seen = input.source.text ?? '';
        return { entityId: input.entityId, claims: [], agent: { via: 'copilot', model: 'test' } };
      };
      await claimsOne(root, entityRels[0], spy);
      expect(seen).toBe(text); // the whole source, beyond the "Steve" mention span
    });
  });
});

describe.skipIf(!gitAvailable)('the entity node gets a regenerable claims block (CLAIMS-9/11)', () => {
  it('adds a delimited block linking the claim, leaving identity + heading intact', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      const before = await fs.readFile(path.join(root, entityRels[0]), 'utf8');
      const refBefore = parseEntityNode(before);

      await claimsOne(root, entityRels[0], claimsDeciderFor([aClaim()]));
      const after = await fs.readFile(path.join(root, entityRels[0]), 'utf8');

      expect(after).toContain('<!-- kb:claims:start');
      expect(after).toMatch(/\[\[claims\/.+\.md\]\] — Owns the Q3 budget\. \*\(interpretation, 0\.7\)\*/);
      // Identity is untouched (CLAIMS-11): same kind/name/derivedFrom, heading preserved.
      expect(parseEntityNode(after)).toEqual(refBefore);
      expect(after).toContain('# Steve');
    });
  });

  // SPEC-0050 slice-2b: a durable RETRACT correction suppresses the claim from the regenerated block,
  // keyed on the subject's STABLE block identity + statement (so it outlives the claim file's reborn
  // ULID). The claim FILE is still written — evidence is preserved; only the surface display is nudged.
  it('a durable RETRACT suppresses the claim from the regenerated block (claim file still kept)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']); // identity person|steve
      // The Principal retracted one claim (as the future "correct this" path will record it), committed
      // so claimsOne's worktree (branched from HEAD) sees it.
      await recordCorrectionDirective(root, { type: 'retract', identityKey: 'person|steve', statement: 'Owns the Q3 budget.', reviewId: 'R', decidedAt: '2026-06-15T00:00:00Z' });
      const git = simpleGit(root);
      await git.raw('add', '-A');
      await git.commit('test: retract directive');

      await claimsOne(root, entityRels[0], claimsDeciderFor([
        aClaim({ statement: 'Owns the Q3 budget.' }),
        aClaim({ statement: 'Leads the platform team.' }),
      ]));

      const node = await fs.readFile(path.join(root, entityRels[0]), 'utf8');
      expect(node).toContain('Leads the platform team.'); // kept claim listed
      expect(node).not.toContain('Owns the Q3 budget.'); // retracted claim suppressed from the block
      expect(await readClaimFiles(root)).toHaveLength(2); // BOTH claim files still on disk (evidence preserved)
    });
  });

  // SPEC-0050 slice-2c: a REATTRIBUTE ("this claim is on the wrong subject") suppresses the claim from
  // the WRONG subject's block too (same suppression as retract; surfacing it on the corrected target is a
  // documented follow-up). Keyed on the wrong subject's stable identity + statement → survives replay.
  it('a durable REATTRIBUTE suppresses the claim from the WRONG subject block (claim file still kept)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']); // identity person|steve
      await recordCorrectionDirective(root, { type: 'reattribute', identityKey: 'person|steve', statement: 'Owns the Q3 budget.', toIdentity: 'person|dana', reviewId: 'R', decidedAt: '2026-06-15T00:00:00Z' });
      const git = simpleGit(root);
      await git.raw('add', '-A');
      await git.commit('test: reattribute directive');

      await claimsOne(root, entityRels[0], claimsDeciderFor([
        aClaim({ statement: 'Owns the Q3 budget.' }),
        aClaim({ statement: 'Leads the platform team.' }),
      ]));

      const node = await fs.readFile(path.join(root, entityRels[0]), 'utf8');
      expect(node).toContain('Leads the platform team.'); // unaffected claim listed
      expect(node).not.toContain('Owns the Q3 budget.'); // reattributed claim suppressed from the wrong subject
      expect(await readClaimFiles(root)).toHaveLength(2); // both claim files kept (evidence preserved)
    });
  });

  it('is idempotent on re-poke: no duplicate block or claim files (CLAIMS-13/16)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      await claimsOne(root, entityRels[0], claimsDeciderFor([aClaim()]));
      expect(await readClaimsQueue(root)).toHaveLength(0); // dequeued (commit-to-dequeue)

      // A second drain must not re-claim the entity (terminal marker) or duplicate files.
      const stage = new ClaimsStage(root, claimsDeciderFor([aClaim()]));
      await stage.poke();
      expect(await readClaimFiles(root)).toHaveLength(1);
      const node = await fs.readFile(path.join(root, entityRels[0]), 'utf8');
      expect(node.match(/kb:claims:start/g)).toHaveLength(1);
    });
  });
});

describe.skipIf(!gitAvailable)('sources and entity identity are never mutated (CLAIMS-11)', () => {
  it('leaves source raw + source.md byte-for-byte unchanged', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { srcRel, entityRels } = await setup(root, 'immutable ground truth', ['truth']);
      const rawBefore = await fs.readFile(path.join(root, srcRel, 'raw.md'), 'utf8');
      const mdBefore = await fs.readFile(path.join(root, srcRel, 'source.md'), 'utf8');
      await claimsOne(root, entityRels[0], claimsDeciderFor([aClaim()]));
      expect(await fs.readFile(path.join(root, srcRel, 'raw.md'), 'utf8')).toBe(rawBefore);
      expect(await fs.readFile(path.join(root, srcRel, 'source.md'), 'utf8')).toBe(mdBefore);
    });
  });
});

describe.skipIf(!gitAvailable)('signals route to the audit log only (CLAIMS-13/14)', () => {
  it('writes signals into the source audit.jsonl envelope, never into claims or the entity', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { srcRel, entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      await claimsOne(root, entityRels[0], claimsDeciderFor([aClaim()], [{ type: 'possible-duplicate', note: 'maybe S. Park', refs: ['Steve'] }]));

      const audit = await fs.readFile(path.join(root, srcRel, 'audit.jsonl'), 'utf8');
      const sig = audit.split('\n').map((l) => (l.trim() ? JSON.parse(l) : null)).find((o) => o && o.event === 'signal');
      expect(sig).toMatchObject({ stage: 'claims', entityId: path.basename(entityRels[0], '.md'), event: 'signal', type: 'possible-duplicate', note: 'maybe S. Park' });
      expect(sig.ts).toBeTruthy(); // CLAIMS-14 envelope timestamp

      const claims = (await readClaimFiles(root)).join('\n');
      expect(claims).not.toContain('possible-duplicate');
      expect(claims).not.toContain('maybe S. Park');
      const node = await fs.readFile(path.join(root, entityRels[0]), 'utf8');
      expect(node).not.toContain('maybe S. Park');
    });
  });
});

describe.skipIf(!gitAvailable)('empty claims is a valid outcome (CLAIMS §3.6)', () => {
  it('commits zero claim files, a placeholder block, and dequeues with a claimed marker', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { srcRel, entityRels } = await setup(root, 'name-dropped only', ['Mentioned']);
      const res = await claimsOne(root, entityRels[0], claimsDeciderFor([]));
      expect(res.ok).toBe(true);
      expect(res.claimIds).toHaveLength(0);
      expect(await readClaimFiles(root)).toHaveLength(0);
      expect(await readClaimsQueue(root)).toHaveLength(0); // still dequeued
      const audit = await fs.readFile(path.join(root, srcRel, 'audit.jsonl'), 'utf8');
      expect(audit).toContain('"event":"claimed"');
      expect(await fs.readFile(path.join(root, entityRels[0]), 'utf8')).toContain('_No claims derived yet._');
    });
  });
});

describe.skipIf(!gitAvailable)('no cross-source claim dedup in v1 (CLAIMS-17)', () => {
  it('two entities (same name, different sources) each get their own claims', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await setup(root, 'Steve owns budget A', ['Steve']);
      await setup(root, 'Steve owns budget B', ['Steve']);
      const ents = await findEntityFiles(root);
      expect(ents).toHaveLength(2); // two un-merged Steve nodes (the graph may hold same-name nodes)
      for (const e of ents) await claimsOne(root, e, claimsDeciderFor([aClaim()]));
      expect(await readClaimFiles(root)).toHaveLength(2); // one claim per entity, not merged
    });
  });
});

describe.skipIf(!gitAvailable)('CLAIMS-21 — a Connect-merged entity derives claims from EVERY source (data-loss regression)', () => {
  // ONE claim per call whose statement IS the source's text — so each source's facts are
  // distinguishable and we can prove BOTH sources contributed, not just provenance.derivedFrom[0].
  const perSourceClaim: ClaimsDecider = async (input) => ({
    entityId: input.entityId,
    claims: [aClaim({ statement: input.source.text ?? '', mentions: [input.name] })],
    agent: { via: 'copilot', model: 'test' },
  });

  it('processes per (entity × source): both sources contribute claims, each with single-source provenance', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // The repro: a Connect-merged "Grace Hopper" node spanning two sources, each asserting a
      // DIFFERENT fact. Pre-fix only derivedFrom[0] (srcA) is ever processed → factB is silently
      // dropped (the reproduced data loss). Post-fix every source contributes its claims.
      const factA = 'Grace Hopper invented the first compiler.';
      const factB = 'Grace Hopper was a rear admiral in the United States Navy.';
      const srcA = await archiveText(root, factA);
      const srcB = await archiveText(root, factB);
      const entityRel = await seedMergedEntity(root, 'Grace Hopper', [srcA, srcB]);

      await new ClaimsStage(root, perSourceClaim).poke(); // drain the whole queue

      // BOTH sources' facts are present — one claim file per source (data loss closed).
      const claims = await readClaimFiles(root);
      expect(claims).toHaveLength(2);
      const joined = claims.join('\n---\n');
      expect(joined).toContain(factA); // derivedFrom[0] — always worked
      expect(joined).toContain(factB); // the LATER source — dropped pre-fix, present post-fix

      // Each claim carries its OWN single source as provenance (clean per-claim provenance, CLAIMS-21).
      const claimFor = (fact: string) => claims.find((c) => c.includes(fact))!;
      expect(claimFor(factA)).toContain(`derivedFrom: ["${srcA}"]`);
      expect(claimFor(factB)).toContain(`derivedFrom: ["${srcB}"]`);

      // The entity's regenerated claims block links BOTH claims (union across sources, CLAIMS-9).
      const node = await fs.readFile(path.join(root, entityRel), 'utf8');
      expect(node.match(/\[\[claims\/.+\.md\]\]/g) ?? []).toHaveLength(2);

      // Fully drained — every (entity × source) pair has a terminal marker (commit-to-dequeue).
      expect(await readClaimsQueue(root)).toHaveLength(0);
    });
  });

  it('a per-source failure sets aside only THAT source — the entity\'s other sources still claim (CLAIMS-12 per pair)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const factA = 'Ada Lovelace wrote the first algorithm.';
      const srcA = await archiveText(root, factA);
      const srcBad = await archiveText(root, 'unused — this source dir is deleted below');
      const entityRel = await seedMergedEntity(root, 'Ada Lovelace', [srcA, srcBad]);
      // Make srcBad poison: delete its captured payload so readSourceInput throws for that source only.
      await fs.rm(path.join(root, srcBad), { recursive: true, force: true });
      await simpleGit(root).raw('add', '-A');
      await simpleGit(root).commit('test: drop one source dir (poison that pair)');

      const stage = new ClaimsStage(root, perSourceClaim, new Mutex(), DEFAULT_MAX_ATTEMPTS);
      for (let n = 0; n < DEFAULT_MAX_ATTEMPTS + 1; n++) await stage.poke(); // must NOT hang/loop

      // The good source claimed; the poison source is set aside after K — queue drains (no head-of-line block).
      expect(await readClaimsQueue(root)).toHaveLength(0);
      const claims = await readClaimFiles(root);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toContain(factA);
      expect(claims[0]).toContain(`derivedFrom: ["${srcA}"]`);
      // The good source's claim is linked in the block (the poison source contributed nothing).
      const node = await fs.readFile(path.join(root, entityRel), 'utf8');
      expect(node.match(/\[\[claims\/.+\.md\]\]/g) ?? []).toHaveLength(1);
    });
  });
});

describe.skipIf(!gitAvailable)('CLAIMS-21 perf — block regen is scoped to the entity\'s OWN claims (no full claims/ scan)', () => {
  // One claim per call whose statement is the source text — lets us tell each entity's claims apart.
  const claimText: ClaimsDecider = async (input) => ({
    entityId: input.entityId,
    claims: [aClaim({ statement: input.source.text ?? '', mentions: [input.name] })],
    agent: { via: 'copilot', model: 'test' },
  });

  /** Seed N unrelated single-source entities and claim them all; return their claim ids (the file
   *  basenames). After this, claims/ holds lots of files belonging to OTHER entities. */
  async function seedNoise(root: string, n: number): Promise<Set<string>> {
    const ids = new Set<string>();
    for (let i = 0; i < n; i++) {
      const { entityRels } = await setup(root, `Unrelated fact ${i}`, [`Noise${i}`]);
      const res = await claimsOne(root, entityRels[0], claimText);
      res.claimIds.forEach((id) => ids.add(id));
    }
    return ids;
  }

  it('regenerates the correct multi-source block amid many UNRELATED claims, leaving them untouched (output-preserving)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const noise = await seedNoise(root, 6);
      expect(noise.size).toBe(6);
      expect(await readClaimFiles(root)).toHaveLength(6);

      const factA = 'Grace Hopper invented the first compiler.';
      const factB = 'Grace Hopper was a rear admiral in the United States Navy.';
      const srcA = await archiveText(root, factA);
      const srcB = await archiveText(root, factB);
      const target = await seedMergedEntity(root, 'Grace Hopper', [srcA, srcB]);
      await new ClaimsStage(root, claimText).poke();

      // The target's block links BOTH its sources' claims (correct + complete), unaffected by the noise.
      const node = await fs.readFile(path.join(root, target), 'utf8');
      expect(node.match(/\[\[claims\/.+\.md\]\]/g) ?? []).toHaveLength(2);
      expect(node).toContain(factA);
      expect(node).toContain(factB);
      // All 6 unrelated + 2 target claim files present and unchanged — no cross-entity drift.
      expect(await readClaimFiles(root)).toHaveLength(8);
    });
  });

  it('does NOT read unrelated entities\' claim files when regenerating a block (the complexity win)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const noise = await seedNoise(root, 5); // unrelated claim ids — must NOT be read during the target regen

      const srcA = await archiveText(root, 'Ada Lovelace wrote the first algorithm.');
      const srcB = await archiveText(root, 'Ada Lovelace worked with Charles Babbage.');
      const target = await seedMergedEntity(root, 'Ada Lovelace', [srcA, srcB]);
      await claimsOne(root, target, claimText); // source A claimed → block now references A's claim path

      // Regenerating for source B reads A's claim file (via the block's wikilink) but must touch NO
      // unrelated claim file — pre-fix this walked all of claims/ (O(vault)); now it's O(entity claims).
      const spy = vi.spyOn(fs, 'readFile');
      try {
        await claimsOne(root, target, claimText); // source B → block regen
      } finally {
        const readIds = spy.mock.calls
          .map((c) => path.basename(String(c[0]), '.md'))
          .filter((b) => noise.has(b));
        spy.mockRestore();
        expect(readIds).toEqual([]); // no unrelated claim file was opened
      }
    });
  });

  it('drops a block wikilink whose claim file was deleted (CLAIMS-19 dedup) — no crash, no broken link', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const factA = 'Ada Lovelace wrote the first algorithm.';
      const factB = 'Ada Lovelace worked with Charles Babbage.';
      const srcA = await archiveText(root, factA);
      const srcB = await archiveText(root, factB);
      const target = await seedMergedEntity(root, 'Ada Lovelace', [srcA, srcB]);

      await claimsOne(root, target, claimText); // source A claimed → block references A's claim file
      let node = await fs.readFile(path.join(root, target), 'utf8');
      const aPath = (node.match(/\[\[(claims\/[^\]]+)\]\]/) ?? [])[1];
      expect(aPath).toBeTruthy();

      // Simulate CLAIMS-19 dedup deleting A's claim file while its wikilink still sits in the block —
      // the `catch { continue }` skip path: a referenced-but-missing claim file must not crash regen
      // or leave a dangling `[[…]]` link.
      await fs.rm(path.join(root, aPath), { force: true });
      await simpleGit(root).raw('add', '-A');
      await simpleGit(root).commit('test: drop a claim file referenced by the block (dedup)');

      await claimsOne(root, target, claimText); // source B → regen reads the (now-missing) A path, skips it
      node = await fs.readFile(path.join(root, target), 'utf8');
      const rows = node.match(/\[\[claims\/.+\.md\]\]/g) ?? [];
      expect(rows).toHaveLength(1); // only B survives — the dead A link is dropped, not dangling
      expect(rows[0]).not.toContain(aPath); // no broken link to the deleted file
      expect(node).toContain(factB);
    });
  });

  it('regenerates correctly from claims/ even when the block was hand-edited/corrupted (claims/ is canonical, not the block)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const factA = 'Ada Lovelace wrote the first algorithm.';
      const factB = 'Ada Lovelace worked with Charles Babbage.';
      const srcA = await archiveText(root, factA);
      const srcB = await archiveText(root, factB);
      const target = await seedMergedEntity(root, 'Ada Lovelace', [srcA, srcB]);

      await claimsOne(root, target, claimText); // source A claimed → block has A's row
      let node = await fs.readFile(path.join(root, target), 'utf8');
      expect(node).toContain(factA);

      // HAND-EDIT the Obsidian block: corrupt the rendered statement (keep the [[claims/…]] wikilink),
      // commit it to canonical — the exact "user edited the view between runs" hazard.
      node = node.replace(factA, 'TOTALLY WRONG HUMAN EDIT');
      await fs.writeFile(path.join(root, target), node, 'utf8');
      await simpleGit(root).raw('add', '-A');
      await simpleGit(root).commit('test: hand-edit (corrupt) the rendered claims block');

      // Source B's regen pulls A's data from the CANONICAL claim file (via the intact wikilink), so the
      // corrupted display is overwritten — the block is never trusted as state (D's robustness invariant).
      await claimsOne(root, target, claimText);
      node = await fs.readFile(path.join(root, target), 'utf8');
      expect(node).toContain(factA); // A's correct statement, restored from claims/
      expect(node).not.toContain('TOTALLY WRONG HUMAN EDIT'); // the hand-edit did NOT become authoritative
      expect(node).toContain(factB);
      expect(node.match(/\[\[claims\/.+\.md\]\]/g) ?? []).toHaveLength(2);
    });
  });
});

describe.skipIf(!gitAvailable)('failure never loses the entity; set aside after K (CLAIMS-12)', () => {
  it('retries then sets aside a poison entity without blocking the queue or writing claims', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'Steve and Dana', ['Steve', 'Dana']);
      const poison = entityRels[0];
      const poisonId = path.basename(poison, '.md');

      const decider: ClaimsDecider = async (input) => {
        if (input.entityId === poisonId) throw new Error('boom');
        return claimsDeciderFor([aClaim()])(input);
      };
      const stage = new ClaimsStage(root, decider, new Mutex(), DEFAULT_MAX_ATTEMPTS);
      for (let n = 0; n < DEFAULT_MAX_ATTEMPTS + 1; n++) await stage.poke();

      expect(await readClaimsQueue(root)).toHaveLength(0); // no head-of-line block
      // Exactly one claim file — for the good entity; none for the poison one.
      expect(await readClaimFiles(root)).toHaveLength(1);
      // The poison entity node has no claims block (its work was discarded on failure).
      expect(await fs.readFile(path.join(root, poison), 'utf8')).not.toContain('kb:claims:start');
    });
  });
});

describe.skipIf(!gitAvailable)('BUG #135 — an incomplete/missing source is set aside, never poison-loops (ORCH-12)', () => {
  it('an entity whose derivedFrom source dir is ABSENT sets aside after K — the drain recovers (no 172× loop)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // Seed a resolved entity pointing at a source dir that was NEVER archived — the incomplete-source
      // condition #135 hit. Claims' `readSourceInput` ENOENTs; before the fix the set-aside marker ALSO
      // ENOENTed (appendFile into the missing dir) → the marker never persisted → `failures` never
      // incremented → the entity retried forever (the 172× `claims.drain-error` wedge). It must now recover.
      const ghostSrc = 'sources/2026/06/02/01GHOSTSRCMISSINGAUDIT0';
      const [orphan] = await seedEntities(root, ghostSrc, ['Orphan']);
      const srcAbsent = await fs
        .access(path.join(root, ghostSrc))
        .then(() => false)
        .catch(() => true);
      expect(srcAbsent).toBe(true); // the source dir is genuinely absent

      const stage = new ClaimsStage(root, claimsDeciderFor([aClaim()]), new Mutex(), DEFAULT_MAX_ATTEMPTS);
      for (let n = 0; n < DEFAULT_MAX_ATTEMPTS + 1; n++) await stage.poke(); // must NOT throw or hang

      // ORCH-12: set aside after K → the queue DRAINS. Pre-fix it never drained (the set-aside threw) →
      // the poison-loop. Now an empty queue proves the stage recovered.
      expect(await readClaimsQueue(root)).toHaveLength(0);
      expect(await readClaimFiles(root)).toHaveLength(0); // nothing fabricated for the orphan
      // The orphan node's identity is untouched — no claims block (CLAIMS-11).
      expect(await fs.readFile(path.join(root, orphan), 'utf8')).not.toContain('kb:claims:start');
    });
  });
});

describe.skipIf(!gitAvailable)('shares the canonical-writer lock with Decompose (SPEC-0014 §5)', () => {
  it('decompose + claims advance the same canonical ref without racing', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // A seeded entity gives Claims work; a second fresh source gives Decompose work (candidates).
      await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      await captureToInbox(root, 'in-app-panel', [{ kind: 'text', text: 'Dana' }]);
      const q = await readQueue(root);
      const src2 = await archiveOne(root, q[q.length - 1], deterministicDecider);

      const lock = new Mutex();
      const decompose = new DecomposeStage(root, decompDeciderFor(['Dana']), lock);
      const claims = new ClaimsStage(root, claimsDeciderFor([aClaim()]), lock);
      await Promise.all([decompose.poke(), claims.poke()]);
      void src2;

      // The shared lock serialized both stages' canonical ff-advances — no race, clean tree.
      expect((await simpleGit(root).status()).isClean()).toBe(true);
      // Decompose wrote a candidate (not an entity), so the Claims queue stays drained.
      await claims.poke();
      expect(await readClaimsQueue(root)).toHaveLength(0);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });
});

// ── SPEC-0018 REVIEW: raise → park → answer → resume → cascade (via the Claims stage) ──

/** A decider that raises one review (and produces no claims) — the "ask, don't guess" path. */
function raiseDeciderFor(question = 'Is this the same Steve as Steve Jones?'): ClaimsDecider {
  return async (input) => ({
    entityId: input.entityId,
    claims: [],
    reviews: [{ question, detail: 'why this matters and what a yes/no means', refs: [input.name] }],
    agent: { via: 'copilot', model: 'test' },
  });
}

describe.skipIf(!gitAvailable)('raising a review parks only that item (REVIEW-5)', () => {
  it('writes an open review, parks the entity, and applies no claims', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      const res = await claimsOne(root, entityRels[0], raiseDeciderFor());

      expect(res.parked).toBe(true);
      expect(res.claimIds).toHaveLength(0);
      expect(await readClaimFiles(root)).toHaveLength(0); // nothing applied until answered
      expect(await readClaimsQueue(root)).toHaveLength(0); // parked → excluded from the queue
      const open = await findOpenReviews(root);
      expect(open).toHaveLength(1);
      expect(open[0].question).toContain('Steve');
      expect(open[0].raisedBy.item.ref).toBe(entityRels[0]);
    });
  });

  it('parks ONLY the raising item; sibling entities keep draining', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const { entityRels } = await setup(root, 'Steve and Dana', ['Steve', 'Dana']);
      const parkId = path.basename(entityRels[0], '.md');
      const decider: ClaimsDecider = async (input) =>
        input.entityId === parkId
          ? { entityId: input.entityId, claims: [], reviews: [{ question: 'q?', detail: 'd' }], agent: { via: 'copilot', model: 'test' } }
          : claimsDeciderFor([aClaim()])(input);

      await new ClaimsStage(root, decider).poke();
      expect(await readClaimsQueue(root)).toHaveLength(0); // one parked, one claimed — none left queued
      expect(await readClaimFiles(root)).toHaveLength(1); // the non-parked sibling was claimed
      expect(await findOpenReviews(root)).toHaveLength(1); // the parked one awaits an answer
    });
  });
});

describe.skipIf(!gitAvailable)('answering resumes the parked item (REVIEW-6)', () => {
  // Raise on the first pass (no prior answers); claim once the question is answered.
  const raiseThenClaim: ClaimsDecider = async (input) =>
    (input.priorReviews?.length ?? 0) === 0
      ? { entityId: input.entityId, claims: [], reviews: [{ question: 'Is this Steve, Steve Jones?', detail: 'ctx', refs: [input.name] }], agent: { via: 'copilot', model: 'test' } }
      : { entityId: input.entityId, claims: [aClaim()], agent: { via: 'copilot', model: 'test' } };

  it('confirm re-enqueues the item and the re-run produces claims', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      await claimsOne(root, entityRels[0], raiseThenClaim); // parks
      const [open] = await findOpenReviews(root);

      const ans = await answerReview(root, lock, open.id, { verdict: 'confirm' });
      expect(ans.ok).toBe(true);
      expect(await findOpenReviews(root)).toHaveLength(0); // answered → leaves the queue
      expect(await readClaimsQueue(root)).toHaveLength(1); // re-enqueued (REVIEW-6)

      await claimsOne(root, entityRels[0], raiseThenClaim); // resumes → claims now
      expect(await readClaimFiles(root)).toHaveLength(1);
      const rev = await getReview(root, open.id);
      expect(rev?.status).toBe('answered');
      expect(rev?.answer?.verdict).toBe('confirm');
    });
  });

  it('feeds the answered review back to the re-run as authoritative context (REVIEW-6)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve', ['Steve']);
      await claimsOne(root, entityRels[0], raiseDeciderFor('Is this Steve, Steve Jones?'));
      const [open] = await findOpenReviews(root);
      await answerReview(root, lock, open.id, { verdict: 'reject', note: "it's Steve Lin" });

      let seen: unknown;
      const spy: ClaimsDecider = async (input) => {
        seen = input.priorReviews;
        return { entityId: input.entityId, claims: [aClaim()], agent: { via: 'copilot', model: 'test' } };
      };
      await claimsOne(root, entityRels[0], spy);
      expect(seen).toEqual([{ question: 'Is this Steve, Steve Jones?', verdict: 'reject', note: "it's Steve Lin" }]);
    });
  });

  it('an answer note becomes a primary source, linked from the review (REVIEW-7)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve', ['Steve']);
      await claimsOne(root, entityRels[0], raiseDeciderFor());
      const [open] = await findOpenReviews(root);

      await answerReview(root, lock, open.id, { verdict: 'reject', note: "it's Steve Lin" });
      const rev = await getReview(root, open.id);
      expect(rev?.answer?.noteSourceId).toBeTruthy();
      // The note was captured into the ingest inbox as a new primary unit (propagates on its own).
      const inbox = await readQueue(root);
      expect(inbox.some((u) => u.includes(rev!.answer!.noteSourceId!))).toBe(true);
    });
  });
});

describe.skipIf(!gitAvailable)('cascade: a resumed run may raise a follow-up (REVIEW-8)', () => {
  // Raise q1 (0 prior), q2 (1 prior), then claim (2 prior).
  const cascade: ClaimsDecider = async (input) => {
    const n = input.priorReviews?.length ?? 0;
    return n < 2
      ? { entityId: input.entityId, claims: [], reviews: [{ question: `q${n + 1}?`, detail: 'd' }], agent: { via: 'copilot', model: 'test' } }
      : { entityId: input.entityId, claims: [aClaim()], agent: { via: 'copilot', model: 'test' } };
  };

  it('answering one review can surface the next, then resolve', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve', ['Steve']);

      await claimsOne(root, entityRels[0], cascade); // park q1
      const [o1] = await findOpenReviews(root);
      expect(o1.question).toBe('q1?');
      await answerReview(root, lock, o1.id, { verdict: 'confirm' });

      await claimsOne(root, entityRels[0], cascade); // resume → raises q2 (cascade)
      const [o2] = await findOpenReviews(root);
      expect(o2.question).toBe('q2?');
      await answerReview(root, lock, o2.id, { verdict: 'confirm' });

      await claimsOne(root, entityRels[0], cascade); // resume → claims
      expect(await readClaimFiles(root)).toHaveLength(1);
      expect(await findOpenReviews(root)).toHaveLength(0);
    });
  });

  it('a runaway cascade is set aside after the round cap (REVIEW-8)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve', ['Steve']);
      const alwaysRaise = raiseDeciderFor('q?');

      for (let i = 0; i < DEFAULT_MAX_REVIEW_ROUNDS; i++) {
        await claimsOne(root, entityRels[0], alwaysRaise); // park
        for (const o of await findOpenReviews(root)) await answerReview(root, lock, o.id, { verdict: 'confirm' });
      }
      const res = await claimsOne(root, entityRels[0], alwaysRaise); // round cap reached
      expect(res.setAside).toBe(true);
      expect(await readClaimsQueue(root)).toHaveLength(0); // set aside — no longer queued
    });
  });
});

describe.skipIf(!gitAvailable)('CLAIMS-20 — set-aside items are user-recoverable (retry / dismiss; OBS-17 / #137)', () => {
  // A decider whose cognition always throws → the entity fails every attempt and is set aside after K.
  const boom: ClaimsDecider = async () => {
    throw new Error('boom');
  };

  /** Drive one entity to set-aside by failing it K times (one cognition attempt per claimsOne call). */
  async function setAside(root: string, entityRel: string, lock: Mutex): Promise<void> {
    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) await claimsOne(root, entityRel, boom, lock);
  }

  it('retry re-enqueues a set-aside item, which then derives claims on a fresh good run', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      const rel = entityRels[0];

      await setAside(root, rel, lock);
      // Set aside: out of the work queue, ON the recoverable list with its failure count.
      expect(await readClaimsQueue(root)).not.toContain(rel);
      const list = await listSetAsideItems(root);
      expect(list.map((i) => i.entityRel)).toEqual([rel]);
      expect(list[0].failures).toBe(DEFAULT_MAX_ATTEMPTS);
      expect(list[0].name).toBe('Steve');

      // Retry → re-enters the queue, leaves the recoverable list (terminal cleared, failures reset).
      await retryClaimsItem(root, rel, lock);
      expect(await readClaimsQueue(root)).toContain(rel);
      expect(await listSetAsideItems(root)).toHaveLength(0);

      // A fresh GOOD run now claims it — proving the `reopened` marker truly reset the count.
      const res = await claimsOne(root, rel, claimsDeciderFor([aClaim()]), lock);
      expect(res.ok).toBe(true);
      expect(res.claimIds).toHaveLength(1);
      expect(await readClaimFiles(root)).toHaveLength(1);
      expect(await readClaimsQueue(root)).not.toContain(rel); // claimed → terminal again
    });
  });

  it('retry is PER-ENTITY — a sibling derived from the same source stays set aside', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      // Two entities, SAME source (same audit.jsonl) — the case a source-wide epoch reset would break.
      const { entityRels } = await setup(root, 'Steve and Dana ran the project', ['Steve', 'Dana']);
      const [a, b] = entityRels;
      await setAside(root, a, lock);
      await setAside(root, b, lock);
      expect((await listSetAsideItems(root)).map((i) => i.entityRel).sort()).toEqual([a, b].sort());

      await retryClaimsItem(root, a, lock); // retry ONLY a
      const queue = await readClaimsQueue(root);
      expect(queue).toContain(a); // a re-enqueued
      expect(queue).not.toContain(b); // b untouched — still set aside
      expect((await listSetAsideItems(root)).map((i) => i.entityRel)).toEqual([b]);
    });
  });

  it('dismiss permanently retires a set-aside item — off the recoverable list, never re-derived', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      const rel = entityRels[0];
      await setAside(root, rel, lock);

      await dismissClaimsItem(root, rel, lock);
      expect(await listSetAsideItems(root)).toHaveLength(0); // off the recoverable list
      expect(await readClaimsQueue(root)).not.toContain(rel); // not re-enqueued

      // A full drain with a GOOD decider must NOT resurrect it (dismissed is terminal).
      const before = (await readClaimFiles(root)).length;
      await new ClaimsStage(root, claimsDeciderFor([aClaim()]), lock, DEFAULT_MAX_ATTEMPTS).poke();
      expect(await readClaimFiles(root)).toHaveLength(before); // nothing derived
      const ref = parseEntityNode(await fs.readFile(path.join(root, rel), 'utf8'));
      const state = await readClaimsState(path.join(root, ref.sources[0]), path.basename(rel, '.md'));
      expect(state.terminalReason).toBe('dismissed'); // distinct from the recoverable `setaside`
    });
  });

  it('listSetAsideItems returns ONLY set-aside items — not claimed successes, not dismissed', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve, Dana, and Cleo', ['Steve', 'Dana', 'Cleo']);
      const [claimed, stuck, dismissed] = entityRels;
      await claimsOne(root, claimed, claimsDeciderFor([aClaim()]), lock); // claimed (success → terminal)
      await setAside(root, stuck, lock); // set aside (recoverable)
      await setAside(root, dismissed, lock);
      await dismissClaimsItem(root, dismissed, lock); // dismissed (retired)

      const list = await listSetAsideItems(root);
      expect(list.map((i) => i.entityRel)).toEqual([stuck]); // only the set-aside one
      expect(list[0].name).toBe('Dana');
      expect(list[0].derivedFrom).toBeTruthy();
    });
  });

  it('retry then re-fail sets it aside again (the failure count restarts cleanly)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const lock = new Mutex();
      const { entityRels } = await setup(root, 'Steve owns the Q3 budget', ['Steve']);
      const rel = entityRels[0];

      await setAside(root, rel, lock);
      await retryClaimsItem(root, rel, lock);
      // After the reopen the count is back to 0 — a fresh K failures are needed to set it aside again.
      const ref = parseEntityNode(await fs.readFile(path.join(root, rel), 'utf8'));
      const sourceDir = path.join(root, ref.sources[0]);
      expect((await readClaimsState(sourceDir, path.basename(rel, '.md'))).failures).toBe(0);

      await setAside(root, rel, lock); // fail K more times
      expect((await listSetAsideItems(root)).map((i) => i.entityRel)).toEqual([rel]); // recoverable again
      expect((await readClaimsState(sourceDir, path.basename(rel, '.md'))).terminalReason).toBe('setaside');
    });
  });
});

// SPEC-0061 T1 / ENG-9 (#539 QA fast-follow) — end-to-end proof through readClaimsQueue, the consumer
// that actually PARSES what findEntityFiles collects (findEntityFiles itself is a pure file listing —
// it has nothing to skip; the parse-and-skip step lives here, at line ~326's try/catch). No git/
// pipeline machinery needed — readClaimsQueue is pure fs against a plain directory tree.
describe('readClaimsQueue — a malformed entity file is skipped end-to-end, never throws (#539 QA fast-follow)', () => {
  it('a malformed entity (no frontmatter) sitting in entities/ does not crash the queue scan', async () => {
    const root = await makeTempDir('kb-findentityfiles-');
    try {
      await fs.mkdir(path.join(root, 'entities', 'concept'), { recursive: true });
      await fs.writeFile(path.join(root, 'entities', 'concept', 'broken.md'), 'not a valid entity — no frontmatter\n', 'utf8');

      // findEntityFiles itself DOES include broken.md (it's a pure .md listing, no parsing) — confirms
      // the walk-vs-parse split is exactly what's under test here.
      expect(await findEntityFiles(root)).toContain(path.join('entities', 'concept', 'broken.md'));

      // readClaimsQueue parses each file and `continue`s past a throw (claimsStage.ts's own comment:
      // "unreadable/foreign node — skip") — no throw, and the malformed entity never reaches the queue.
      const queue = await readClaimsQueue(root);
      expect(queue).toEqual([]);
    } finally {
      await rmTempDir(root);
    }
  });

  it('a malformed entity does not block a well-formed sibling from being correctly evaluated', async () => {
    const root = await makeTempDir('kb-findentityfiles-');
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

      // No source/audit trail exists for the well-formed entity either, so it's correctly NOT queued
      // (firstPendingSource has nothing to find) — the assertion is that evaluating it at all didn't
      // throw or get short-circuited by the malformed sibling earlier in the (sorted) walk order.
      await expect(readClaimsQueue(root)).resolves.toEqual([]);
    } finally {
      await rmTempDir(root);
    }
  });
});
