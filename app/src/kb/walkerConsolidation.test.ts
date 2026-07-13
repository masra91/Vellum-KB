// SPEC-0061 T1 / ENG-9 (#530/#539) — the grep gate the epic's own AC calls for: a test that scans
// `src/kb/` for the ad-hoc-walker FINGERPRINT (a function that reads a directory with
// `{ withFileTypes: true }` and recurses into itself via `isDirectory()`) and fails if one appears
// outside the known, deliberately-kept set. This is what stops a "13th" ad-hoc walker from being
// silently reintroduced — new code should reach for the shared `walkVaultFiles` (`vaultWalk.ts`)
// instead, and if the shape genuinely doesn't fit (as `decomposeStage.ts`/`watchConnectors.ts` don't),
// that choice should be a deliberate, reviewed addition to the allowlist below, not a silent drift.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const KB_DIR = path.join(__dirname); // app/src/kb, this file's own directory

/** Deliberately-kept ad-hoc walkers, each with a documented reason (see the file itself for the
 *  in-code rationale — this list is just the enforcement side of that decision). */
const ALLOWED = new Set([
  'vaultWalk.ts', // the shared helper itself — its own recursion IS the walker
  'watchConnectors.ts', // richer safety model (maxDepth/ignoreGlobs/loop-guard) — the template, not a target
  'decomposeStage.ts', // directory-collecting leaf-detection — a different collection shape, see findSourceDirs's doc comment
]);

/** Pre-existing walkers NOT yet retired — found during #539's grep-gate implementation, outside the
 *  issue's originally-enumerated 12 (activityIndex.ts was mid-rewrite by a concurrent wave-2 lane at
 *  the time; conversionCounts.ts wasn't part of the original ENG-9 audit). Tracked, not silently
 *  dropped — see the #539 PR description for the follow-up issue. Remove an entry here the same PR
 *  that retires it, so this allowlist always reflects reality. */
const KNOWN_FOLLOWUP = new Set([
  'activityIndex.ts', // findFiles() — concurrent with Dev-4's #508 byte-offset rewrite; deferred to avoid collision
  'conversionCounts.ts', // countFiles() — newly found, not in the original 12; small, low-risk follow-up
]);

/** Walkers already retired by #530/#539 — regression guard: if one of these files starts matching the
 *  fingerprint again, something reintroduced an ad-hoc walk instead of using `walkVaultFiles`. */
const MUST_STAY_CLEAN = [
  'recallTools.ts',
  'graphProjection.ts',
  'claimsStage.ts',
  'connectStage.ts',
  'mergeNodes.ts',
  'claimDedup.ts',
  'recall.ts',
  'enrichTrigger.ts',
  'reviewStore.ts',
];

/** Extract every `[async] function NAME(...) { ... }` body via brace-balancing (good enough for this
 *  codebase's consistent style — not a full parser, just a fingerprint scanner). Matches nested/inner
 *  function declarations too (a flat scan, not scope-aware), which is exactly what's needed: the
 *  ad-hoc walkers are almost always a private `walk`/`rec` helper declared INSIDE an exported function. */
function extractFunctionBodies(src: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    let depth = 1;
    let i = re.lastIndex;
    const start = i;
    while (depth > 0 && i < src.length) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push({ name, body: src.slice(start, Math.max(start, i - 1)) });
  }
  return out;
}

/** True iff `body` reads a directory with `withFileTypes: true` AND calls `name` again inside itself —
 *  the ad-hoc recursive-walker fingerprint (`walkVaultFiles`'s own `walk` matches this too, by design;
 *  that's why the gate is file-based against an explicit allowlist, not "zero matches anywhere"). */
function isAdHocWalker(name: string, body: string): boolean {
  return body.includes('withFileTypes: true') && new RegExp(`\\b${name}\\s*\\(`).test(body);
}

async function filesWithAdHocWalkers(): Promise<string[]> {
  const entries = await fs.readdir(KB_DIR, { withFileTypes: true });
  const hits: string[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue;
    const src = await fs.readFile(path.join(KB_DIR, e.name), 'utf8');
    const bodies = extractFunctionBodies(src);
    if (bodies.some(({ name, body }) => isAdHocWalker(name, body))) hits.push(e.name);
  }
  return hits.sort();
}

describe('walker consolidation grep gate (SPEC-0061 T1 / ENG-9, #539)', () => {
  it('no ad-hoc recursive readdir walker exists outside the documented allowlist', async () => {
    const hits = await filesWithAdHocWalkers();
    const unexpected = hits.filter((f) => !ALLOWED.has(f) && !KNOWN_FOLLOWUP.has(f));
    expect(unexpected).toEqual([]);
  });

  it('none of the already-retired files have regressed back to an ad-hoc walker', async () => {
    const hits = new Set(await filesWithAdHocWalkers());
    const regressed = MUST_STAY_CLEAN.filter((f) => hits.has(f));
    expect(regressed).toEqual([]);
  });

  it('the fingerprint detector actually catches the known shape (sanity — a detector that never fires proves nothing)', () => {
    const sample = `
async function outer(root) {
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) if (e.isDirectory()) await walk(e.name);
  }
  await walk(root);
}`;
    const bodies = extractFunctionBodies(sample);
    expect(bodies.some(({ name, body }) => isAdHocWalker(name, body))).toBe(true);
  });
});
