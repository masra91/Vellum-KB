// The canonical entity-merge core (SPEC-0020 CONNECT-10/11) — extracted so it has ONE impl with
// two callers: Connect's `connectOne` (merge two existing nodes during resolution) and Reflect's
// approved consolidation (SPEC-0024 REFLECT-5/7, execute a Principal-approved merge). Pure FS in a
// worktree; the caller owns the commit + canonical ff-advance. Merging = repoint the losers' claims
// to the canonical node, regenerate the canonical's claims block, and delete the loser files (no
// tombstones — recoverable via git; the deletion mirrors to `main` via the deletion-aware gate).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { applyClaimsBlock, type ClaimBacklink } from './claimDoc';
import { checkContainedRel } from './pathContainment';
import { walkVaultFiles } from './vaultWalk';

/** Minimal claim view for repointing + regenerating the canonical node's claims block. */
interface ClaimRef {
  rel: string; // repo-relative claim file path
  subject: string; // current subject (entity rel path)
  statement: string;
  status: string;
  confidence: number;
  derivedFrom: string; // source dir (provenance) — for the VAULT-13 citation on regenerated rows
}

function parseClaim(md: string, rel: string): ClaimRef | null {
  const fmEnd = md.indexOf('\n---', 3);
  if (fmEnd === -1) return null;
  const fm = md.slice(0, fmEnd);
  const body = md.slice(fmEnd + 4).trim();
  let subject = '';
  let status = '';
  let confidence = 0;
  let derivedFrom = '';
  for (const line of fm.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^subject:\s*(.+)$/))) subject = m[1].trim().replace(/^"|"$/g, '');
    else if ((m = line.match(/^status:\s*(.+)$/))) status = m[1].trim();
    else if ((m = line.match(/^confidence:\s*(.+)$/))) confidence = Number(m[1].trim()) || 0;
    else if ((m = line.match(/^\s+derivedFrom:\s*(\[.*\])\s*$/))) {
      try {
        const arr = JSON.parse(m[1]) as unknown[];
        if (Array.isArray(arr) && arr.length > 0) derivedFrom = String(arr[0]);
      } catch {
        /* leave empty — citation simply omitted for this row */
      }
    }
  }
  if (!subject) return null;
  // Statement = the body's FIRST line. A claim body may carry a trailing "Source: [[…]]" citation
  // (VAULT-13) that is provenance, not the assertion — exclude it (parity with the recallTools /
  // connectStage parsers fixed in #116; this was the third claim-body parser, latently affected).
  const statement = body.split('\n', 1)[0]?.trim() ?? '';
  return { rel, subject, statement, status, confidence, derivedFrom };
}

/** Every claim under `wtRoot/claims`, repo-relative.
 *  SPEC-0061 T1 / ENG-9 (#539): file collection delegates to the shared `walkVaultFiles`; parsing
 *  (previously fused into the walk) is now a separate pass, same skip-on-null behavior. */
async function readClaims(wtRoot: string): Promise<ClaimRef[]> {
  const out: ClaimRef[] = [];
  const rels = await walkVaultFiles(wtRoot, 'claims', { keep: (n) => n.endsWith('.md') });
  for (const rel of rels) {
    const c = parseClaim(await fs.readFile(path.join(wtRoot, rel), 'utf8'), rel);
    if (c) out.push(c);
  }
  return out;
}

/** Rewrite a claim file's `subject:` to the canonical node path (CONNECT-11). */
async function repointClaimSubject(wtRoot: string, claimRel: string, newSubject: string): Promise<void> {
  const file = path.join(wtRoot, claimRel);
  const md = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, md.replace(/^subject:\s*.+$/m, `subject: ${newSubject}`), 'utf8');
}

/** Regenerate the canonical node's claims block from all claims now pointing at it (CONNECT-11). */
async function regenClaimsBlock(wtRoot: string, nodeRel: string, claims: ClaimRef[]): Promise<void> {
  const file = path.join(wtRoot, nodeRel);
  const md = await fs.readFile(file, 'utf8');
  const links: ClaimBacklink[] = claims.map((c) => ({
    claimPath: c.rel,
    statement: c.statement,
    status: c.status as ClaimBacklink['status'],
    confidence: c.confidence,
    source: c.derivedFrom || undefined, // VAULT-13: navigable source citation on merge-regenerated rows
  }));
  await fs.writeFile(file, applyClaimsBlock(md, links), 'utf8');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** The only directory entity nodes live in — merge inputs must resolve under it. */
const NODE_ROOT = 'entities';

/**
 * Reject a node rel that escapes the worktree or isn't under `entities/` (Class-A containment).
 * `canonicalRel`/`loserRels` are LLM-emitted (the Reflect agent's consolidation plan, REFLECT-5/7)
 * and drive `fs.writeFile` + `fs.rm` below — a DESTRUCTIVE sink and a prompt-injection surface (same
 * class as JOBS-10 #52/#61, worse consequence). The Review approval covers the *prose* ("Merge X into
 * Y?"), NOT the paths, so contain them HERE before any fs op — via the shared **symlink-safe** helper
 * (SPEC-0030 #30: one containment impl across the path-injection family). Connect's own callers pass
 * located-node rels (always under `entities/`), so they pass trivially. The reason strings are kept
 * exact so the caller's throw message is unchanged. Returns a reason for the first offender, or null.
 */
async function uncontainedNodeRel(wt: string, rels: readonly string[]): Promise<string | null> {
  for (const rel of rels) {
    const r = await checkContainedRel(wt, rel, [NODE_ROOT]);
    if ('kind' in r) {
      return r.kind === 'escape' ? `node path escapes the worktree: ${rel}` : `node path outside ${NODE_ROOT}/: ${rel}`;
    }
  }
  return null;
}

/** Loser rels actually deleted by a merge (those that existed). */
export interface MergeResult {
  deleted: string[];
}

/**
 * Merge `loserRels` into `canonicalRel` within worktree `wt` (CONNECT-10/11): repoint every claim
 * whose subject is a loser → the canonical node, regenerate the canonical's claims block, then
 * delete the loser node files. Idempotent: a loser that is already gone is simply skipped (an
 * already-merged plan → empty `deleted`). The caller commits + ff-advances the canonical (so the
 * deletion mirrors to `main` via the deletion-aware promotion gate). The canonical itself is never
 * a loser (callers exclude it).
 */
export async function mergeNodes(wt: string, canonicalRel: string, loserRels: readonly string[]): Promise<MergeResult> {
  const losers = loserRels.filter((r) => r && r !== canonicalRel);
  if (losers.length === 0) return { deleted: [] };
  // Contain the LLM-emitted node paths (canonical + losers) BEFORE any write/delete — they ride in
  // the consolidation markerKey, not the Principal's approval prose, so the approval doesn't vouch
  // for them (destructive-sink path injection; mirror JOBS-10 #61). Validate-first → a throw leaves
  // nothing mutated. Connect's located-node rels always satisfy this.
  const unsafe = await uncontainedNodeRel(wt, [canonicalRel, ...losers]);
  if (unsafe) throw new Error(`mergeNodes: refusing unsafe path — ${unsafe}`);
  const loserSet = new Set(losers);

  // Repoint the losers' claims to the canonical node (CONNECT-11).
  for (const claim of await readClaims(wt)) {
    if (loserSet.has(claim.subject)) await repointClaimSubject(wt, claim.rel, canonicalRel);
  }
  // Regenerate the canonical's claims block from everything now pointing at it.
  const claimsForCanonical = (await readClaims(wt)).filter((c) => c.subject === canonicalRel);
  if (claimsForCanonical.length > 0) await regenClaimsBlock(wt, canonicalRel, claimsForCanonical);

  // Delete the loser node files (no tombstones; recoverable via git history — CONNECT-10).
  const deleted: string[] = [];
  for (const rel of losers) {
    if (await pathExists(path.join(wt, rel))) {
      await fs.rm(path.join(wt, rel), { force: true });
      deleted.push(rel);
    }
  }
  return { deleted };
}
