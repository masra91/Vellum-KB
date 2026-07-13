// Terminology glossary enforcement (specs/design/terminology.md §0/§5-7): "Library" is the product
// noun in UI copy; bare "KB" and generic "vault" are banned there. The Obsidian *vault* concept itself
// is a named carve-out ("Obsidian vault" is allowed — it's a real term for a real, distinct thing).
//
// VUX-RETIRE #523 §8 — extends the check to the three files that predate the v3 lexicon sweep:
// renderer.ts (first-run setup), permissionGate.ts, settingsView.ts. Scans raw source with comments
// stripped, not just rendered output — renderer.ts has no exported pure functions to call directly
// (it's an entry-point module), so this is the only way to cover it. Comment-stripping matters because
// `\bvault\b`/`\bKB\b` (word-boundary) already don't match identifiers like `vaultPath`/`kbApi` — the
// real false-positive risk is explanatory comment PROSE ("a vault in a LOCAL TCC-gated folder"), which
// is legitimate engineering vocabulary, not UI text, and must not fail this check.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Strip `//` line comments and `/* ... *\/` block comments so only code + string literals remain. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const FILES = [
  path.join(__dirname, 'renderer.ts'),
  path.join(__dirname, 'shell', 'permissionGate.ts'),
  path.join(__dirname, 'shell', 'views', 'settingsView.ts'),
];

describe('VUX-RETIRE #523 §8 — zero banned terms (\\bKB\\b, generic vault) in the scrubbed old-UI files', () => {
  for (const file of FILES) {
    const rel = path.relative(__dirname, file);
    const code = stripComments(readFileSync(file, 'utf8'));

    it(`${rel}: no bare "KB" outside code identifiers`, () => {
      expect(code).not.toMatch(/\bKB\b/);
    });

    it(`${rel}: no generic "vault" in string/template content outside code identifiers`, () => {
      // Identifiers (vaultPath, vaultConfig, isICloudVault, probeVaultAccess, …) are one continuous
      // word-char run — \b requires a boundary, so it never matches inside them, only a standalone word.
      expect(code).not.toMatch(/\bvault\b/i);
    });
  }
});
