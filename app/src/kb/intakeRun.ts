// One intake connector run pass (SPEC-0041 INTAKE-3/7/8/10/12) — substrate-agnostic orchestration
// behind the fetch seam. The actual feed read (RSS fetch+parse / M365 mail query) is INJECTED as an
// `IntakeFetchFn`, so this module is unit-testable without a network and the connector adapter stays
// the only place that touches the wire (mirrors researchRun.ts ↔ the Web/M365 adapters).
//
// POSTURE:
// - INTAKE-3 (compose the spine): each new item is written as an immutable PRIMARY source via
//   `captureToInbox` (origin:'external'), which mints a system-controlled ULID path (`inbox/<ulid>/`)
//   and commits before processing. No LLM-/feed-derived string ever becomes a filesystem path.
// - INTAKE-7 (read-only world): the connector only READS the feed; this module never asks it to
//   mutate the remote. The only state INTAKE persists is its own local dedup ledger.
// - INTAKE-8 (dedup/idempotency): a per-connector seen-ledger keyed on the item's stable external id
//   (content-hash fallback) guarantees a previously-ingested item is never re-archived.
// - INTAKE-12 (failure ≠ empty): a fetch/auth failure is audited as a DISTINCT `intake-failed` event
//   (never a silent `no-new-items`), already-archived items in a partial batch stay preserved (each
//   capture commits independently), and the ledger only records items actually ingested.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { captureToInbox } from './ingest';
import { appendAuditEvent } from './audit';
import type { Mutex } from './stageLock';
import {
  DEFAULT_MAX_ITEMS_PER_PASS,
  isSafeConnectorId,
  renderIntakeSourceBody,
  type IntakeConnectorConfig,
  type IntakeFetchFn,
  type IntakeItem,
} from './intakeConnectors';

/** The dedup key for an item (INTAKE-8): the stable external id, or a content-hash fallback when the
 *  feed gives no id. Lives here (backend) — it uses node `crypto`, which must not enter the renderer
 *  bundle (STACK-6); `intakeConnectors.ts` stays renderer-safe for the Sources view. */
export function intakeDedupKey(item: IntakeItem): string {
  const ext = item.externalId.trim();
  if (ext) return `id:${ext}`;
  const h = createHash('sha256').update(`${item.title}\n${item.link ?? ''}\n${item.contentMd}`).digest('hex');
  return `hash:${h}`;
}

/** Absolute path to a connector's dedup ledger (INTAKE-8). The `id` is slug-validated before this is
 *  ever built (belt-and-suspenders over the registry guard) so it can never traverse `.kb/intake`. */
export function intakeSeenPath(root: string, id: string): string {
  return path.join(path.resolve(root), '.kb', 'intake', id, 'seen.json');
}

/** Read a connector's seen-ledger (the set of dedup keys already ingested). Missing/malformed → empty. */
export async function readIntakeSeen(root: string, id: string): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(intakeSeenPath(root, id), 'utf8');
  } catch {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

/** Persist a connector's seen-ledger. Mirrors the research dispatcher's plain-file ledger pattern
 *  (the in-worktree file is the operative dedup state; `.kb/intake/` is tracked, never promoted). */
export async function writeIntakeSeen(root: string, id: string, seen: Set<string>): Promise<void> {
  const p = intakeSeenPath(root, id);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify([...seen]) + '\n', 'utf8');
}

export interface RunIntakeDeps {
  /** The injected feed read (READ-ONLY; INTAKE-7). Production = the RSS/M365 adapter; tests inject. */
  fetch: IntakeFetchFn;
  /** Injectable ISO clock (deterministic tests). */
  now?: () => string;
  /** #517: the shared canonical-writer lock — serializes each ingested item's `captureToInbox` commit
   *  against stage advances/other writers on the same git index. Production (`IntakeScheduler`) always
   *  supplies it; tests that don't exercise concurrent writers may omit it. */
  lock?: Mutex;
}

export interface RunIntakeResult {
  /** Primary source ids produced this pass (empty when nothing new / on failure). */
  sourceIds: string[];
  /** What the pass inspected (for audit + summary). */
  inspected: string;
  /** One-liner outcome. */
  note: string;
  /** The pass FAILED (fetch/auth error) vs legitimately finding nothing new — kept distinct so a
   *  broken feed surfaces an error, never a silent no-op (INTAKE-12 / OBS-4). */
  failed?: boolean;
  /** The failure cause, when `failed`. */
  error?: string;
}

/**
 * Run one bounded intake pass for connector `c`: fetch the currently-available items (bounded to
 * `maxItemsPerPass`), drop any already in the dedup ledger, and write each genuinely-new item as an
 * immutable PRIMARY source via the ingest spine (origin:'external'). Emits a conforming `intake`
 * audit event (`intook` / `no-new-items` / `intake-failed`) and advances the ledger only for items
 * actually ingested. Defensive: an unsafe connector id is refused before any path is touched.
 */
export async function runIntakeConnector(root: string, c: IntakeConnectorConfig, deps: RunIntakeDeps): Promise<RunIntakeResult> {
  if (!isSafeConnectorId(c.id)) throw new Error(`runIntakeConnector: refusing unsafe connector id ${JSON.stringify(c.id)}`);
  const now = deps.now ?? (() => new Date().toISOString());
  const maxItems = c.maxItemsPerPass && c.maxItemsPerPass > 0 ? Math.floor(c.maxItemsPerPass) : DEFAULT_MAX_ITEMS_PER_PASS;

  // Fetch (the only external touch — READ-ONLY, INTAKE-7). A failure is a DISTINCT audited event,
  // never a silent empty (INTAKE-12): a stripped-auth M365 or an unreachable feed must surface.
  let items: IntakeItem[];
  try {
    items = await deps.fetch(c, { maxItems });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await appendAuditEvent(root, {
      actor: 'intake',
      eventType: 'intake-failed',
      ts: now(),
      subjects: { intakeId: c.id },
      payload: { type: c.type, scope: c.scope, sensitivity: c.sensitivity, error },
    });
    return { sourceIds: [], inspected: `${c.type}:${c.id}`, note: `intake failed: ${error}`, failed: true, error };
  }

  const inspected = `${c.type}:${c.id} (${items.length} item${items.length === 1 ? '' : 's'} available)`;
  const seen = await readIntakeSeen(root, c.id);
  // New = not already ingested. Slice-1 dedups on the stable external id ONLY (content-hash fallback
  // when absent): a re-served item is skipped — never re-archived (INTAKE-8, the safety half). The
  // spec's revision-snapshot semantics (re-ingest an *edited* item under the same id via
  // `external-id + last-modified`) are DEFERRED: many feeds re-stamp pubDate/updated on every fetch,
  // so folding a timestamp into the key would risk re-archive floods — the conservative
  // never-re-archive guarantee is the Slice-1 priority. (Tracked for a later slice.)
  const fresh = items.filter((it) => !seen.has(intakeDedupKey(it)));

  if (fresh.length === 0) {
    await appendAuditEvent(root, {
      actor: 'intake',
      eventType: 'no-new-items',
      ts: now(),
      subjects: { intakeId: c.id },
      payload: { type: c.type, inspected, scope: c.scope, sensitivity: c.sensitivity },
    });
    return { sourceIds: [], inspected, note: 'no new items' };
  }

  const sourceIds: string[] = [];
  const ingestedKeys: string[] = [];
  let failure: string | undefined;
  try {
    for (const it of fresh) {
      const fetchedAt = now();
      const publishedMs = it.publishedAt ? Date.parse(it.publishedAt) : NaN;
      const stampMs = Number.isFinite(publishedMs) ? publishedMs : Date.parse(fetchedAt) || Date.now();
      // Contained write: ULID path, body supplied by the connector. origin:'external' → a PRIMARY
      // source that re-enters the pipeline (Decompose→Connect→Claims) like any capture (INTAKE-3).
      // The connector-default scope/sensitivity ride the capture as the archivist's classification
      // hint (INTAKE-9 / SCOPE-14) so a `confidential` feed isn't down-classified to the default.
      const doCapture = () =>
        captureToInbox(root, `intake:${c.id}`, [{ kind: 'text', text: renderIntakeSourceBody(c, it, fetchedAt) }], stampMs, {
          origin: 'external',
          scope: c.scope,
          sensitivity: c.sensitivity,
        });
      // #517: serialize ONLY this commit against other writers on the same git index. #507 item 4:
      // priority — an intake-ingest capture must never queue behind Connect's bulk sweep tail.
      const out = deps.lock ? await deps.lock.run(doCapture, `intake:${c.id}`, { priority: true }) : await doCapture();
      sourceIds.push(...out.ids);
      ingestedKeys.push(intakeDedupKey(it));
      seen.add(intakeDedupKey(it));
    }
  } catch (err) {
    // A capture failed mid-batch (INTAKE-12): items already committed stay preserved; record the
    // partial outcome + the error, and only the successfully-ingested keys enter the ledger.
    failure = err instanceof Error ? err.message : String(err);
  }

  // Advance the ledger for items actually ingested (INTAKE-8). Done even on partial failure so a
  // committed source is never re-archived on the next pass.
  if (ingestedKeys.length > 0) await writeIntakeSeen(root, c.id, seen);

  await appendAuditEvent(root, {
    actor: 'intake',
    eventType: 'intook',
    ts: now(),
    subjects: { intakeId: c.id, ...(sourceIds[0] ? { sourceId: sourceIds[0] } : {}) },
    payload: {
      type: c.type,
      count: sourceIds.length,
      externalKeys: ingestedKeys,
      sourceIds,
      links: fresh.slice(0, ingestedKeys.length).map((it) => it.link ?? '').filter(Boolean),
      scope: c.scope,
      sensitivity: c.sensitivity,
      ...(failure ? { partialFailure: failure } : {}),
    },
  });

  const note = failure
    ? `intook ${sourceIds.length} item(s), then failed: ${failure}`
    : `intook ${sourceIds.length} new item(s)`;
  return { sourceIds, inspected, note, ...(failure ? { failed: true, error: failure } : {}) };
}
