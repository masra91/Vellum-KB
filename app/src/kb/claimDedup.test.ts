import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dedupeClaimsWithinSource,
  normalizeStatement,
  countSuspectedRelationalResiduals,
  applyClaimDedup,
  type DedupClaim,
} from './claimDedup';
import { renderClaimMd, applyClaimsBlock, CLAIMS_BLOCK_START, type ClaimBacklink } from './claimDoc';
import type { ClaimDecision } from './claims';

// ── A small DedupClaim factory for the pure tests ───────────────────────────────────────────
const c = (over: Partial<DedupClaim> = {}): DedupClaim => ({
  rel: `claims/2026/06/02/${over.id ?? 'id0'}.md`,
  id: 'id0',
  subject: 'entities/person/Ada.md',
  derivedFrom: ['sources/2026/06/02/S1'],
  statement: 'Ada Lovelace worked with Charles Babbage.',
  status: 'fact',
  confidence: 0.9,
  relatesTo: [],
  ...over,
});

describe('normalizeStatement (CLAIMS-19)', () => {
  it('is case-, whitespace-, and trailing-punctuation-insensitive', () => {
    expect(normalizeStatement('  Ada   Lovelace WORKED with Babbage.  ')).toBe(
      normalizeStatement('ada lovelace worked with babbage'),
    );
    expect(normalizeStatement('"Owns the Q3 budget!"')).toBe(normalizeStatement('Owns the Q3 budget'));
  });

  it('is ORDER-SENSITIVE — symmetric rewordings are distinct (CONNECT-20 residual, not Tier-1)', () => {
    expect(normalizeStatement('A worked with B')).not.toBe(normalizeStatement('B worked with A'));
  });
});

describe('dedupeClaimsWithinSource — within-source near-duplicate collapse (CLAIMS-19)', () => {
  it('collapses exact + trivially-reworded duplicates within one source, keeping ONE survivor', () => {
    const claims = [
      c({ id: 'a', status: 'interpretation', confidence: 0.8, subject: 'entities/person/Ada.md' }),
      c({ id: 'b', status: 'fact', confidence: 0.6, subject: 'entities/person/Babbage.md' }),
      c({ id: 'c', statement: 'ada lovelace   WORKED with charles babbage', status: 'hypothesis' }),
    ];
    const { keep, drop, groups } = dedupeClaimsWithinSource(claims);
    expect(keep).toHaveLength(1);
    expect(drop).toHaveLength(2);
    expect(groups).toHaveLength(1);
    // fact outranks interpretation/hypothesis regardless of confidence/subject → 'b' is canonical
    expect(keep[0].id).toBe('b');
  });

  it('canonical pick: higher confidence wins within the same status, then earliest id', () => {
    const conf = dedupeClaimsWithinSource([
      c({ id: 'a', status: 'fact', confidence: 0.5 }),
      c({ id: 'b', status: 'fact', confidence: 0.9 }),
    ]);
    expect(conf.keep[0].id).toBe('b'); // confidence tiebreak

    const ties = dedupeClaimsWithinSource([
      c({ id: 'zzz', status: 'fact', confidence: 0.9 }),
      c({ id: 'aaa', status: 'fact', confidence: 0.9 }),
    ]);
    expect(ties.keep[0].id).toBe('aaa'); // earliest-id tiebreak
  });

  it('NEVER merges across different sources (preserves CLAIMS-17)', () => {
    const { keep, drop } = dedupeClaimsWithinSource([
      c({ id: 'a', derivedFrom: ['sources/2026/06/02/S1'] }),
      c({ id: 'b', derivedFrom: ['sources/2026/06/02/S2'] }), // same statement, different source
    ]);
    expect(keep).toHaveLength(2);
    expect(drop).toHaveLength(0);
  });

  it('NEVER merges symmetric rewordings (the CONNECT-20 residual)', () => {
    const { keep } = dedupeClaimsWithinSource([
      c({ id: 'a', statement: 'Ada worked with Babbage' }),
      c({ id: 'b', statement: 'Babbage worked with Ada' }),
    ]);
    expect(keep).toHaveLength(2);
  });

  it('is idempotent — re-running over the survivors drops nothing more', () => {
    const first = dedupeClaimsWithinSource([
      c({ id: 'a', status: 'fact' }),
      c({ id: 'b', status: 'hypothesis' }),
    ]);
    const second = dedupeClaimsWithinSource(first.keep);
    expect(second.drop).toHaveLength(0);
    expect(second.keep).toHaveLength(first.keep.length);
  });
});

describe('countSuspectedRelationalResiduals — heuristic upper bound → CONNECT-20 (CLAIMS-19)', () => {
  it('counts a kept claim that relatesTo a co-present same-source entity', () => {
    const kept = [
      c({ id: 'a', subject: 'entities/person/Ada.md', relatesTo: ['Babbage'] }),
      c({ id: 'b', subject: 'entities/person/Babbage.md', statement: 'Babbage worked with Ada', relatesTo: ['Ada'] }),
    ];
    expect(countSuspectedRelationalResiduals(kept)).toBe(2); // both reference a co-present peer
  });

  it('does not count relatesTo hints that point outside this source', () => {
    const kept = [c({ id: 'a', subject: 'entities/person/Ada.md', relatesTo: ['Someone Else'] })];
    expect(countSuspectedRelationalResiduals(kept)).toBe(0);
  });
});

// ── The file-effecting pass (no git: commit-free + isolated; the stage wires/commits later) ──
describe('applyClaimDedup — the within-source dedup PASS (CLAIMS-19)', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-dedup-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const SRC = 'sources/2026/06/02/S1';
  const claimRel = (id: string) => `claims/2026/06/02/${id}.md`;

  const writeClaim = async (id: string, subject: string, claim: ClaimDecision, derivedFrom = SRC) => {
    const rel = claimRel(id);
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, renderClaimMd(claim, { id, subject, derivedFrom, createdAt: '2026-06-02T00:00:00Z' }), 'utf8');
    return rel;
  };

  const writeEntity = async (subjectRel: string, name: string, backlinks: ClaimBacklink[]) => {
    const abs = path.join(root, subjectRel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const base = `---\nid: 01E${name}\nkind: person\nname: ${name}\nprovenance:\n  derivedFrom: ["${SRC}"]\n  transformedBy: "decompose"\n  mentions: ["m"]\ncreatedAt: 2026-06-02T00:00:00Z\n---\n\n# ${name}\n`;
    await fs.writeFile(abs, applyClaimsBlock(base, backlinks), 'utf8');
  };

  const claim = (statement: string, status: ClaimDecision['status'], confidence: number, relatesTo?: string[]): ClaimDecision => ({
    statement,
    status,
    confidence,
    mentions: ['evidence span'],
    ...(relatesTo ? { relatesTo } : {}),
  });

  it('drops within-source dupes, keeps the canonical, regenerates affected blocks, leaves identity intact', async () => {
    const ada = 'entities/person/Ada.md';
    const bab = 'entities/person/Babbage.md';
    const REL = 'Ada Lovelace worked with Charles Babbage.';

    // c1 (Ada, fact) + c2 (Babbage, interpretation) + c3 (Ada, hypothesis, reworded) all == same normalized statement.
    await writeClaim('aac1', ada, claim(REL, 'fact', 0.9));
    await writeClaim('aac2', bab, claim(REL, 'interpretation', 0.8));
    await writeClaim('aac3', ada, claim('ada lovelace   WORKED with charles babbage', 'hypothesis', 0.95));
    // c4 (Ada): symmetric reword — must survive (CONNECT-20 residual). c5 (Ada): different source — must survive.
    await writeClaim('aac4', ada, claim('Charles Babbage worked with Ada Lovelace.', 'fact', 0.9));
    await writeClaim('aac5', ada, claim(REL, 'fact', 0.9), 'sources/2026/06/02/S2');

    await writeEntity(ada, 'Ada', [
      { claimPath: claimRel('aac1'), statement: REL, status: 'fact', confidence: 0.9 },
      { claimPath: claimRel('aac3'), statement: 'reworded', status: 'hypothesis', confidence: 0.95 },
      { claimPath: claimRel('aac4'), statement: 'sym', status: 'fact', confidence: 0.9 },
      { claimPath: claimRel('aac5'), statement: REL, status: 'fact', confidence: 0.9 },
    ]);
    await writeEntity(bab, 'Babbage', [{ claimPath: claimRel('aac2'), statement: REL, status: 'interpretation', confidence: 0.8 }]);

    const report = await applyClaimDedup(root);

    expect(report.inspected).toBe(5);
    expect(report.dropped).toBe(2);
    expect(report.kept).toBe(3);
    expect(report.groups).toHaveLength(1);

    // canonical is the fact claim (aac1); aac2 + aac3 dropped.
    const exists = async (rel: string) => fs.access(path.join(root, rel)).then(() => true).catch(() => false);
    expect(await exists(claimRel('aac1'))).toBe(true);
    expect(await exists(claimRel('aac2'))).toBe(false);
    expect(await exists(claimRel('aac3'))).toBe(false);
    expect(await exists(claimRel('aac4'))).toBe(true); // symmetric reword survives
    expect(await exists(claimRel('aac5'))).toBe(true); // other source survives

    // Ada's block: lists survivors (aac1, aac4, aac5), not the dropped aac3.
    const adaMd = await fs.readFile(path.join(root, ada), 'utf8');
    expect(adaMd).toContain(`[[${claimRel('aac1')}]]`);
    // VAULT-13 residual: dedup-regenerated rows carry the navigable source citation (S1's date).
    expect(adaMd).toContain('[[sources/2026/06/02/S1/source.md|2026-06-02]]');
    expect(adaMd).toContain(`[[${claimRel('aac4')}]]`);
    expect(adaMd).toContain(`[[${claimRel('aac5')}]]`);
    expect(adaMd).not.toContain(`[[${claimRel('aac3')}]]`);
    // identity + heading untouched (CLAIMS-11)
    expect(adaMd).toContain('id: 01EAda');
    expect(adaMd).toContain('# Ada');

    // Babbage lost its only claim → placeholder block, identity intact.
    const babMd = await fs.readFile(path.join(root, bab), 'utf8');
    expect(babMd).not.toContain(`[[${claimRel('aac2')}]]`);
    expect(babMd).toContain(CLAIMS_BLOCK_START);
    expect(babMd).toContain('# Babbage');
    expect(report.affectedSubjects).toEqual([ada, bab].sort());
  });

  it('is idempotent — a second pass drops nothing and changes no files', async () => {
    const ada = 'entities/person/Ada.md';
    const REL = 'Ada Lovelace worked with Charles Babbage.';
    await writeClaim('bbc1', ada, claim(REL, 'fact', 0.9));
    await writeClaim('bbc2', ada, claim(REL, 'interpretation', 0.8));
    await writeEntity(ada, 'Ada', [
      { claimPath: claimRel('bbc1'), statement: REL, status: 'fact', confidence: 0.9 },
      { claimPath: claimRel('bbc2'), statement: REL, status: 'interpretation', confidence: 0.8 },
    ]);

    const first = await applyClaimDedup(root);
    expect(first.dropped).toBe(1);
    const adaAfterFirst = await fs.readFile(path.join(root, ada), 'utf8');

    const second = await applyClaimDedup(root);
    expect(second.dropped).toBe(0);
    expect(second.inspected).toBe(1);
    expect(await fs.readFile(path.join(root, ada), 'utf8')).toBe(adaAfterFirst);
  });

  it('is a clean no-op on a vault with no duplicates', async () => {
    const ada = 'entities/person/Ada.md';
    await writeClaim('cc1', ada, claim('Pioneered the first algorithm.', 'fact', 0.9));
    await writeEntity(ada, 'Ada', [{ claimPath: claimRel('cc1'), statement: 'Pioneered the first algorithm.', status: 'fact', confidence: 0.9 }]);
    const report = await applyClaimDedup(root);
    expect(report.dropped).toBe(0);
    expect(report.affectedSubjects).toEqual([]);
  });

  it('fails closed when a duplicate set would regenerate a subject that escapes entities/ (containment, #80/#82 family)', async () => {
    // Two same-source, same-statement claims whose subject path traverses out of the vault → a drop
    // is detected, then the affected-subject write-sink is guarded: it must throw, not write outside.
    const evil = '../../../../tmp/evil.md';
    await writeClaim('ev1', evil, claim('X.', 'fact', 0.9));
    await writeClaim('ev2', evil, claim('X.', 'interpretation', 0.8));
    await expect(applyClaimDedup(root)).rejects.toThrow();
  });

  // SPEC-0061 T1 / ENG-9 (#539 QA fast-follow) — end-to-end proof for walkClaimFiles (claimDedup.ts's
  // own private walker): a malformed claim file must not crash the pass, and the well-formed sibling
  // is still correctly inspected.
  it('a malformed claim file (no frontmatter) is silently excluded, never throws (#539 QA fast-follow)', async () => {
    const ada = 'entities/person/Ada.md';
    await writeClaim('good1', ada, claim('Pioneered the first algorithm.', 'fact', 0.9));
    await writeEntity(ada, 'Ada', [{ claimPath: claimRel('good1'), statement: 'Pioneered the first algorithm.', status: 'fact', confidence: 0.9 }]);
    await fs.mkdir(path.join(root, 'claims', '2026', '06', '02'), { recursive: true });
    await fs.writeFile(path.join(root, 'claims', '2026', '06', '02', 'broken.md'), 'not a valid claim — no frontmatter at all\n', 'utf8');

    const report = await applyClaimDedup(root); // no throw on the malformed sibling — the assertion
    expect(report.inspected).toBe(1); // only the well-formed claim was ever counted
    expect(report.dropped).toBe(0);
  });
});
