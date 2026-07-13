// Entity-merge core (SPEC-0020 CONNECT-10/11; reused by Reflect consolidation REFLECT-7). Pure FS.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';
import { mergeNodes } from './mergeNodes';

async function write(root: string, rel: string, content: string): Promise<void> {
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content, 'utf8');
}

const node = (name: string) => `---\nid: ${name}\nkind: person\nname: ${name}\n---\n\n# ${name}\n`;
const claim = (subject: string, statement: string) =>
  `---\nid: 01C\nsubject: ${subject}\nstatus: fact\nconfidence: 0.9\n---\n\n${statement}\n`;

// A claim file in the real post-VAULT-13 shape: provenance.derivedFrom + a trailing "Source: [[…]]"
// citation in the body (what renderClaimMd writes). Exercises the first-line statement parse + the
// source-citation threading on merge-regeneration (VAULT-13 residual).
const claimProv = (subject: string, statement: string, src: string) =>
  `---\nid: 01D\nsubject: ${subject}\nstatus: fact\nconfidence: 0.9\nprovenance:\n  derivedFrom: ["${src}"]\n  transformedBy: claims\n  mentions: ["m"]\ncreatedAt: 2026-05-31T00:00:00Z\n---\n\n${statement}\n\nSource: [[${src}/source.md|2026-05-31]]\n`;

describe('mergeNodes (CONNECT-10/11)', () => {
  it('regenerated block carries a clean statement + the VAULT-13 source citation (residual)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'wt');
      const canonical = 'entities/person/steve-jobs.md';
      const loser = 'entities/person/steven-jobs.md';
      const src = 'sources/2026/05/31/01SRC';
      await write(root, canonical, node('Steve Jobs'));
      await write(root, loser, node('Steven Jobs'));
      await write(root, 'claims/2026/05/31/01D.md', claimProv(loser, 'Co-founded Apple.', src));

      await mergeNodes(root, canonical, [loser]);
      const canonMd = await fs.readFile(path.join(root, canonical), 'utf8');
      // statement is clean (first line, NOT the whole body with its Source trailer) — the #116 parity fix
      expect(canonMd).toContain('— Co-founded Apple. *(fact, 0.9)*');
      // and the row carries the navigable source citation (VAULT-13 on the merge-regenerated path)
      expect(canonMd).toContain(`[[${src}/source.md|2026-05-31]]`);
      // the entity node's block row uses the "·" citation form, never the raw "Source:" body line
      expect(canonMd).not.toContain('Source: [[');
    } finally {
      await rmTempDir(dir);
    }
  });

  it('repoints the loser’s claims to the canonical, regenerates its claims block, deletes the loser', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'wt');
      const canonical = 'entities/person/steve-jobs.md';
      const loser = 'entities/person/steven-jobs.md';
      await write(root, canonical, node('Steve Jobs'));
      await write(root, loser, node('Steven Jobs'));
      await write(root, 'claims/2026/05/31/01C.md', claim(loser, 'Co-founded Apple.'));

      const res = await mergeNodes(root, canonical, [loser]);
      expect(res.deleted).toEqual([loser]);

      expect(await pathExists(path.join(root, loser))).toBe(false); // loser deleted (no tombstone)
      const claimMd = await fs.readFile(path.join(root, 'claims/2026/05/31/01C.md'), 'utf8');
      expect(claimMd).toContain(`subject: ${canonical}`); // claim repointed (CONNECT-11)
      const canonMd = await fs.readFile(path.join(root, canonical), 'utf8');
      expect(canonMd).toContain('Co-founded Apple.'); // regenerated claims block on the canonical
      expect(canonMd).toContain('kb:claims:start');
    } finally {
      await rmTempDir(dir);
    }
  });

  it('is idempotent / safe: an already-gone loser (or self) merges nothing', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'wt');
      const canonical = 'entities/person/steve-jobs.md';
      await write(root, canonical, node('Steve Jobs'));
      expect((await mergeNodes(root, canonical, ['entities/person/gone.md'])).deleted).toEqual([]); // absent loser
      expect((await mergeNodes(root, canonical, [canonical])).deleted).toEqual([]); // never self-merge
      expect(await pathExists(path.join(root, canonical))).toBe(true); // canonical untouched
    } finally {
      await rmTempDir(dir);
    }
  });

  // Path-injection containment (REFLECT-5/7 / JOBS-10 class): `canonicalRel`/`loserRels` are
  // LLM-emitted (the Reflect agent's plan), so a `../` / absolute / non-entities / symlink-escape
  // path must be REFUSED before the destructive fs.writeFile/fs.rm — the approval covers the prose,
  // not the paths. mergeNodes throws and mutates NOTHING (validate-first). QA finder: KB-Quality-Driver.
  it('refuses a `..`-traversal loser path and deletes nothing outside the worktree', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'wt');
      const canonical = 'entities/person/steve-jobs.md';
      await write(root, canonical, node('Steve Jobs'));
      await fs.writeFile(path.join(dir, 'victim.md'), 'precious', 'utf8'); // OUTSIDE the worktree
      await expect(mergeNodes(root, canonical, ['../victim.md'])).rejects.toThrow(/refusing unsafe path/);
      expect(await pathExists(path.join(dir, 'victim.md'))).toBe(true); // never followed out / deleted
      expect(await pathExists(path.join(root, canonical))).toBe(true); // canonical untouched
    } finally {
      await rmTempDir(dir);
    }
  });

  it('refuses a `..`-traversal canonical path, an absolute path, and a non-entities/ path', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'wt');
      const canonical = 'entities/person/steve-jobs.md';
      const loser = 'entities/person/steven-jobs.md';
      await write(root, canonical, node('Steve Jobs'));
      await write(root, loser, node('Steven Jobs'));
      await expect(mergeNodes(root, '../escape.md', [loser])).rejects.toThrow(/refusing unsafe path/); // canonical escapes
      await expect(mergeNodes(root, canonical, ['/etc/passwd'])).rejects.toThrow(/refusing unsafe path/); // absolute
      await expect(mergeNodes(root, canonical, ['claims/2026/x.md'])).rejects.toThrow(/outside entities/); // in-wt but wrong root
      expect(await pathExists(path.join(root, loser))).toBe(true); // nothing deleted
    } finally {
      await rmTempDir(dir);
    }
  });

  it('refuses a loser that escapes via a committed symlink (symlink-safe containment)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'wt');
      const canonical = 'entities/person/steve-jobs.md';
      await write(root, canonical, node('Steve Jobs'));
      const outside = path.join(dir, 'outside');
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(outside, 'node.md'), 'precious', 'utf8');
      await fs.mkdir(path.join(root, 'entities'), { recursive: true });
      await fs.symlink(outside, path.join(root, 'entities', 'escape')); // entities/escape -> <outside>
      await expect(mergeNodes(root, canonical, ['entities/escape/node.md'])).rejects.toThrow(/refusing unsafe path/);
      expect(await pathExists(path.join(outside, 'node.md'))).toBe(true); // never followed out
    } finally {
      await rmTempDir(dir);
    }
  });

  // SPEC-0061 T1 / ENG-9 (#539 QA fast-follow) — end-to-end proof for readClaims (mergeNodes.ts's own
  // private walker): a malformed claim file sitting alongside the real ones must not crash the merge,
  // and the well-formed repoint must still happen correctly.
  it('a malformed claim file (no frontmatter) does not crash the merge — the well-formed repoint still happens (#539 QA fast-follow)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'wt');
      const canonical = 'entities/person/steve-jobs.md';
      const loser = 'entities/person/steven-jobs.md';
      await write(root, canonical, node('Steve Jobs'));
      await write(root, loser, node('Steven Jobs'));
      await write(root, 'claims/2026/05/31/01C.md', claim(loser, 'Co-founded Apple.'));
      await write(root, 'claims/2026/05/31/broken.md', 'not a valid claim — no frontmatter at all\n');

      const res = await mergeNodes(root, canonical, [loser]); // no throw on the malformed sibling — the assertion
      expect(res.deleted).toEqual([loser]);
      const canonMd = await fs.readFile(path.join(root, canonical), 'utf8');
      expect(canonMd).toContain('Co-founded Apple.'); // the well-formed claim was still repointed + regenerated
      // the malformed file was never touched (mergeNodes only writes claims whose subject it recognizes)
      expect(await fs.readFile(path.join(root, 'claims/2026/05/31/broken.md'), 'utf8')).toBe('not a valid claim — no frontmatter at all\n');
    } finally {
      await rmTempDir(dir);
    }
  });
});
