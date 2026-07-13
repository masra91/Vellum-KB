// Pure(-ish — fs reads, no fs writes) build logic for the library index: parse vault files into
// `LibraryIndexStore` rows. DB-agnostic (works identically against the sqlite store and the in-memory
// fake), which is what makes the equivalence tests a straightforward "same input, same output" check
// rather than two parsers that can drift.
//
// Reuses the SAME parsers the live tool surface reads with (`parseEntityNode` from connectDoc,
// `parseClaimMd` from recallTools) — a file the live walker considers malformed is malformed here too,
// by construction, not by re-derivation.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseEntityNode } from './connectDoc';
import { parseClaimMd } from './recallTools';
import { walkVaultFiles } from './vaultWalk';
import type { LibraryIndexStore } from './libraryIndexTypes';

/** Extract `[[target]]` wikilink targets from a node/claim body. Replicated verbatim from
 *  `recallTools`/`graphProjection` (both already duplicate this locally rather than export-edit a
 *  parallel-owned file) — kept local here for the same reason: this file must not touch recallTools.ts
 *  or graphProjection.ts, which other wave-1 lanes own. */
function extractWikilinks(md: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[1].trim());
  return out;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const isMdOrTxt = (n: string): boolean => n.endsWith('.md') || n.endsWith('.txt');

/** `read: false` means the file is gone (caller should delete the row AND its links). `read: true,
 *  parsed: false` means it's a straggler — present but not a valid entity/claim (caller deletes the
 *  entity/claim row, but its links STAY, already recorded below). */
interface IndexFileResult {
  read: boolean;
  parsed: boolean;
}

/** Index (or re-index) one entity file. Outgoing links are recorded for ANY readable `entities/`/
 *  `claims/` file — parseable or not — mirroring `graphProjection.ts`'s `readAllGraphFiles` superset:
 *  the live `linkTraversal.incoming` scan counts a `[[target]]` inside a malformed/orphan file as a
 *  backlink source, so the index must too, or it silently under-counts incoming links on a vault with
 *  any straggler files (the #468 fast-follow this mirrors). */
async function indexEntityFile(store: LibraryIndexStore, root: string, rel: string): Promise<IndexFileResult> {
  let md: string;
  try {
    md = await fs.readFile(path.join(root, rel), 'utf8');
  } catch {
    return { read: false, parsed: false };
  }
  store.setLinksFrom(rel, extractWikilinks(md));
  let node: ReturnType<typeof parseEntityNode>;
  try {
    node = parseEntityNode(md);
  } catch {
    return { read: true, parsed: false };
  }
  store.upsertEntity({
    rel,
    id: node.id,
    kind: node.kind,
    name: node.name,
    aliases: node.aliases,
    confidence: node.confidence,
    tags: node.tags,
    derivedFrom: node.derivedFrom,
    body: md,
  });
  return { read: true, parsed: true };
}

async function indexClaimFile(store: LibraryIndexStore, root: string, rel: string): Promise<IndexFileResult> {
  let md: string;
  try {
    md = await fs.readFile(path.join(root, rel), 'utf8');
  } catch {
    return { read: false, parsed: false };
  }
  // Claims can carry `[[entity]]` references in their body too (the live `linkTraversal.incoming` scan
  // treats every entities/+claims/ file as an incoming-link candidate, not just entity nodes) — index
  // them as outgoing-from-this-claim so `linksTo` stays a faithful inverted index of the SAME source set.
  store.setLinksFrom(rel, extractWikilinks(md));
  let claim: ReturnType<typeof parseClaimMd>;
  try {
    claim = parseClaimMd(md);
  } catch {
    return { read: true, parsed: false };
  }
  store.upsertClaim({
    rel,
    id: claim.id,
    subject: claim.subject,
    status: claim.status,
    confidence: claim.confidence,
    statement: claim.statement,
    derivedFrom: claim.derivedFrom,
    mentions: claim.mentions,
    relatesTo: claim.relatesTo,
    body: md,
  });
  return { read: true, parsed: true };
}

async function indexSourceFile(store: LibraryIndexStore, root: string, rel: string): Promise<boolean> {
  let body: string;
  try {
    body = await fs.readFile(path.join(root, rel), 'utf8');
  } catch {
    return false;
  }
  store.upsertSourceFile({ rel, body, contentHash: sha256(body) });
  return true;
}

/** Full rebuild from the vault alone (git is truth — always a valid recovery path). Clears every row
 *  first so a file deleted since the last build (or since the store was created) doesn't linger. */
export async function rebuildLibraryIndexFull(store: LibraryIndexStore, root: string, head: string): Promise<void> {
  store.clearAll();
  for (const rel of await walkVaultFiles(root, 'entities', { keep: (n) => n.endsWith('.md') })) {
    await indexEntityFile(store, root, rel);
  }
  for (const rel of await walkVaultFiles(root, 'claims', { keep: (n) => n.endsWith('.md') })) {
    await indexClaimFile(store, root, rel);
  }
  for (const rel of await walkVaultFiles(root, 'sources', { keep: isMdOrTxt })) {
    await indexSourceFile(store, root, rel);
  }
  store.setMeta('lastIndexedHead', head);
}

const POSIX = (p: string): string => p.split(path.sep).join('/');

/** Apply an incremental update for exactly the files `git diff --name-only` reports changed between the
 *  last-indexed HEAD and `head`. The canonical root is always checked out AT `head` by the time this
 *  runs (index maintenance is lazy/consumer-triggered, never mid-advance — see `libraryIndex.ts`), so a
 *  changed path is re-read live: present → re-parse and upsert (same malformed-skip rule as a rebuild,
 *  which here means delete any stale row); absent → delete. Paths outside entities/claims/sources, or
 *  not `.md`/`.txt` in sources' case, are irrelevant to the index and ignored. */
export async function applyVaultDiff(store: LibraryIndexStore, root: string, changedRelPaths: string[], head: string): Promise<void> {
  for (const raw of changedRelPaths) {
    const rel = POSIX(raw);
    if (rel.startsWith('entities/') && rel.endsWith('.md')) {
      const r = await indexEntityFile(store, root, rel);
      if (!r.read) store.clearLinksFrom(rel);
      if (!r.parsed) store.deleteEntity(rel); // gone, or a straggler — links (if read) already recorded
    } else if (rel.startsWith('claims/') && rel.endsWith('.md')) {
      const r = await indexClaimFile(store, root, rel);
      if (!r.read) store.clearLinksFrom(rel);
      if (!r.parsed) store.deleteClaim(rel);
    } else if (rel.startsWith('sources/') && isMdOrTxt(rel)) {
      if (!(await indexSourceFile(store, root, rel))) {
        store.deleteSourceFile(rel);
      }
    }
  }
  store.setMeta('lastIndexedHead', head);
}
