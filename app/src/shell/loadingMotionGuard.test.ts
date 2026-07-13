// #520 (VUX-6) static guards — themeCohesion-style source-text assertions, not DOM/layout checks (those
// can't catch a banned literal or a stray duplicate token name). Two rules from the design spec
// (specs/design/shell-chrome-motion.md §8/§12, §7/§12):
//   1. No view may ever fall back to bare "Loading…" markup — every cold-start face is a shaped skeleton.
//   2. The consolidated duration scale (--dur-quick/--dur-state/--dur-settle/--dur-breathe) is the ONLY
//      name for these values — the old --viz-dur-quick / --viz-dur-state / --viz-dur-breathe / bare --t
//      duplicates must not reappear.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SHELL_DIR = path.resolve(process.cwd(), 'src/shell');

/** Recursively list every `.ts` (non-.test.ts) file under `dir` — mirrors what a `grep -r` sweep covers. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('#520 §8/§12 — no bare "Loading…" markup anywhere under src/shell', () => {
  const files = listTsFiles(SHELL_DIR);
  it('scanned at least the 10 views named in the issue (sanity — the guard is actually running)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const rel = path.relative(SHELL_DIR, file);
    it(`${rel} contains no ">Loading…<" literal`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toContain('>Loading…<');
    });
  }
});

describe('#520 §7/§12 — duration token consolidation, no duplicate names survive', () => {
  const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  const designSystemCss = readFileSync(SHELL_DIR + '/design-system.css', 'utf8');
  const combined = indexCss + designSystemCss;

  it('--dur-quick is defined exactly once (single source of truth)', () => {
    const defs = combined.match(/--dur-quick\s*:/g) ?? [];
    expect(defs.length).toBe(1);
  });

  it('no rule references the retired --viz-dur-quick', () => {
    expect(combined).not.toMatch(/--viz-dur-quick/);
  });

  it('no rule references the retired bare --t token', () => {
    expect(combined).not.toMatch(/--t\s*:/);
    expect(combined).not.toMatch(/var\(--t\)/);
  });

  it('no rule references the retired --viz-dur-state / --viz-dur-breathe duplicates', () => {
    expect(combined).not.toMatch(/--viz-dur-state/);
    expect(combined).not.toMatch(/--viz-dur-breathe/);
  });

  it('the consolidated scale defines all four tokens once', () => {
    for (const token of ['--dur-quick', '--dur-state', '--dur-settle', '--dur-breathe']) {
      expect(combined).toMatch(new RegExp(`${token}\\s*:`));
    }
  });

  it('the shimmer keyframe is defined once, under the canonical name (no rev-shimmer/askShimmer duplicates)', () => {
    expect(combined).not.toMatch(/rev-shimmer/);
    expect(combined).not.toMatch(/askShimmer/);
    const defs = combined.match(/@keyframes\s+shimmer\s*\{/g) ?? [];
    expect(defs.length).toBe(1);
  });
});

// #520 §10/§12 — .is-busy and .is-leaving both collapse to instant under reduced-motion (KB-QD-2 gate-2
// note: §12's original list only had a reduced-motion case for the leaving/exit-motion test, not busy).
describe('#520 §10/§12 — .is-busy and .is-leaving both have a reduced-motion reset', () => {
  const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');

  it('.is-busy is defined with the sprout-breathe animation', () => {
    expect(indexCss).toMatch(/\.is-busy\s*\{[^}]*animation:\s*viz-breathe/);
  });

  it('.is-leaving is defined with the fade+lift exit transition', () => {
    expect(indexCss).toMatch(/\.is-leaving\s*\{[^}]*opacity:\s*0/);
  });

  it('a single reduced-motion block resets both .is-busy and .is-leaving (not left un-reset, #520 §7 rule)', () => {
    const reducedMotionBlocks = indexCss.match(/@media \(prefers-reduced-motion: reduce\) \{[^]*?\n\}/g) ?? [];
    const coversBoth = reducedMotionBlocks.some((b) => b.includes('.is-busy') && b.includes('.is-leaving'));
    expect(coversBoth).toBe(true);
  });
});
