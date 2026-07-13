// Past Ask chats — the app-local conversation store (SPEC-0060 VUX-11 slice-2b/2c). Persisted in
// Electron's userData (one JSON file per conversation under `conversations/`), NOT the vault: a past
// chat is app session-state, distinct from Save-to-KB (`saveRecallOutput`) which git-commits an answer
// AS a KB Output. Tiny JSON files, mirroring appConfig's no-electron-store simplicity (PRIN-5), with an
// atomic write (tmp + rename) so a crash mid-save can't leave a half-written chat.
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ulid, isUlid } from '../kb/ulid';
import type { Conversation, ConversationTurn, ConversationSummary } from '../kb/conversation';

export type { Conversation, ConversationTurn, ConversationSummary };

/** Injectable clock + id generator — real impls by default; tests pass deterministic ones. */
export interface ConversationStoreDeps {
  now?: () => string;
  newId?: () => string;
}

const TITLE_MAX = 120;
const PREVIEW_MAX = 140;

function conversationsDir(): string {
  return path.join(app.getPath('userData'), 'conversations');
}
function conversationFile(id: string): string {
  return path.join(conversationsDir(), `${id}.json`);
}

/** First non-empty question → the default title; degrade-safe over missing/partial turns (ENG-15/16). */
function deriveTitle(turns: ConversationTurn[]): string {
  const first = turns.find((t) => t?.result?.question?.trim())?.result.question.trim();
  return (first && first.length > 0 ? first : 'Untitled chat').slice(0, TITLE_MAX);
}

/** A list summary — title + the last answer as a one-line preview + turn count. Null-tolerant. */
function summarize(c: Conversation): ConversationSummary {
  const turns = Array.isArray(c.turns) ? c.turns : [];
  const lastAnswer = [...turns].reverse().find((t) => t?.result?.answer?.trim())?.result.answer.trim() ?? '';
  return {
    id: c.id,
    title: c.title || deriveTitle(turns),
    updatedAt: c.updatedAt,
    turnCount: turns.length,
    preview: lastAnswer.replace(/\s+/g, ' ').slice(0, PREVIEW_MAX),
  };
}

/** Write JSON via tmp + rename so a reader never observes a half-written file (crash-atomic on one fs).
 *  Exported — `appConfig.ts` reuses this (BUG-13, #518) rather than duplicating the idiom. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fs.rename(tmp, file);
}

/**
 * Persist (create OR update) a conversation from its rendered turns (2c save-chat). A valid existing
 * `id` UPDATES that thread (keeps `createdAt`, bumps `updatedAt`); omit it (or pass a non-ULID) to
 * create a fresh one. Returns the id the caller can keep to update the same thread as it grows.
 */
export async function saveConversation(
  turns: ConversationTurn[],
  opts: { id?: string; title?: string } & ConversationStoreDeps = {},
): Promise<{ id: string }> {
  const now = opts.now ?? (() => new Date().toISOString());
  const safeTurns = Array.isArray(turns) ? turns : [];
  const id = opts.id && isUlid(opts.id) ? opts.id : (opts.newId ?? ulid)();
  await fs.mkdir(conversationsDir(), { recursive: true });
  const prior = opts.id && isUlid(opts.id) ? await loadConversation(id) : null;
  const conv: Conversation = {
    id,
    createdAt: prior?.createdAt ?? now(),
    updatedAt: now(),
    title: (opts.title?.trim() || prior?.title || deriveTitle(safeTurns)).slice(0, TITLE_MAX),
    turns: safeTurns,
  };
  await writeJsonAtomic(conversationFile(id), conv);
  return { id };
}

/**
 * List saved conversations newest-first (2b list). A corrupt / half-written / legacy file is SKIPPED,
 * never thrown — one bad chat can't break the whole list (ENG-15/16). No dir yet ⇒ empty list.
 */
export async function listConversations(): Promise<ConversationSummary[]> {
  let names: string[];
  try {
    names = (await fs.readdir(conversationsDir())).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // no conversations dir yet → no past chats
  }
  const out: ConversationSummary[] = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(conversationsDir(), name), 'utf8')) as Conversation;
      if (raw && typeof raw.id === 'string' && typeof raw.updatedAt === 'string') out.push(summarize(raw));
    } catch {
      // skip a corrupt/half-written/legacy file — never let one bad chat break the list
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out;
}

/**
 * Load one conversation by id (2b load). The id MUST be a well-formed ULID — this both validates AND
 * CONTAINS: a crafted `../…` id is not a ULID, so it can never resolve outside `conversations/`. Returns
 * null on an invalid id, a missing/corrupt file, or a shape without the `turns` array.
 */
export async function loadConversation(id: string): Promise<Conversation | null> {
  if (typeof id !== 'string' || !isUlid(id)) return null;
  try {
    const raw = JSON.parse(await fs.readFile(conversationFile(id), 'utf8')) as Conversation;
    return raw && typeof raw.id === 'string' && Array.isArray(raw.turns) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Delete one conversation by id (the Past-chats per-row remove — a thread list with no delete just
 * accretes cruft). ULID-CONTAINED like load: a non-ULID id is rejected before any path is built, so a
 * crafted `../…` can never unlink outside `conversations/`. Idempotent — `ok:true` whether the file was
 * removed or already absent (the row is gone either way); `ok:false` only on an invalid id.
 */
export async function deleteConversation(id: string): Promise<{ ok: boolean }> {
  if (typeof id !== 'string' || !isUlid(id)) return { ok: false };
  try {
    await fs.rm(conversationFile(id), { force: true }); // force ⇒ no throw when already absent
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
