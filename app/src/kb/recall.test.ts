// SPEC-0026 slice 1 — the recall orchestration over the Copilot SDK (ASK-1,3,5,7,11), headless.
// The SDK client is faked: its session runs a SCRIPTED sequence of tool calls against the tools
// recall.ts registered (simulating the agent), ending with submitAnswer — no real CLI is spawned.
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { buildRecallVault, type RecallVault } from '../../test/recallVault';
import { rmTempDir, pathExists, makeTempDir } from '../../test/tempVault';
import { recall, makeReadOnlyTools, buildRecallToolDefs, recallBudget, countEntityNodes, RECALL_BUDGET, finalizeCitations, type RecallClient, type RecallSessionConfig, type Citation } from './recall';
import { CopilotCapacityTimeoutError } from './copilotConcurrency';
import { DEFAULT_RECALL_BUDGET_MS } from './instanceConfig';
import { createKb } from './vault';

interface ScriptStep {
  tool: string;
  args: unknown;
}

/** A fake Copilot-SDK client: drives the registered tool handlers per a script. */
function fakeClient(script: ScriptStep[]): { client: RecallClient; calls: string[]; lastConfig: () => RecallSessionConfig | null } {
  const calls: string[] = [];
  let captured: RecallSessionConfig | null = null;
  const client: RecallClient = {
    async createSession(config) {
      captured = config;
      const byName = new Map((config.tools ?? []).map((t) => [t.name, t]));
      return {
        async sendAndWait(): Promise<unknown> {
          for (const step of script) {
            const tool = byName.get(step.tool);
            if (!tool) continue;
            calls.push(step.tool);
            await tool.handler(step.args, {});
          }
          return { type: 'assistant.message' };
        },
        async disconnect(): Promise<void> {},
      };
    },
    async disconnect(): Promise<void> {},
  };
  return { client, calls, lastConfig: () => captured };
}

const fixedNow = (): string => '2026-06-02T00:00:00.000Z';

describe('recall loop on the Copilot SDK (SPEC-0026 slice 1)', () => {
  let v: RecallVault | undefined;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
    v = undefined;
  });

  it('grounded, cited answer via multi-hop tool calls (ASK-1/5/7) + audit (ASK-11)', async () => {
    v = await buildRecallVault();
    const { client, calls, lastConfig } = fakeClient([
      { tool: 'entityLookup', args: { query: 'Ada' } },
      { tool: 'claimsForEntity', args: { entity: v.adaRel } },
      { tool: 'submitAnswer', args: { answer: 'Ada Lovelace, the first programmer [1].', citations: [{ kind: 'claim', ref: v.claimRel, label: 'first programmer' }], grounded: true } },
    ]);
    const res = await recall(v.root, 'Who was Ada Lovelace?', { client, now: fixedNow });

    expect(res.grounded).toBe(true);
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0].ref).toBe(v.claimRel);
    expect(res.toolCalls).toBe(2); // submitAnswer is not a retrieval call
    expect(res.truncated).toBe(false);
    expect(res.trace?.ok).toBe(true);
    expect(calls).toEqual(['entityLookup', 'claimsForEntity', 'submitAnswer']);

    // Read-only enforced via the allow-list: only our read tools + submitAnswer are exposed (ASK-3).
    const cfg = lastConfig();
    expect(cfg?.allowedTools).toEqual(['entityLookup', 'claimsForEntity', 'linkTraversal', 'readNode', 'readSource', 'grep', 'submitAnswer']);
    expect(cfg?.systemMessage?.content).toContain('Vellum Recall agent');

    const auditPath = path.join(v.root, '.kb', 'cache', 'ask', 'audit.jsonl');
    const audit = JSON.parse((await fs.readFile(auditPath, 'utf8')).trim());
    expect(audit).toMatchObject({ event: 'recall', runtime: 'copilot-sdk', grounded: true, toolCalls: 2, ts: fixedNow() });
    expect(audit.citations).toContain(`claim:${v.claimRel}`);
  });

  // MODEL-AUTO-FALLBACK (ORCH-16 fast-follow): if copilot rejects the pinned model pre-flight at
  // session creation, recall retries ONCE with `--model auto` so a stale pin can't hard-break Q&A.
  it('retries the session with `auto` when the pinned model is rejected pre-flight', async () => {
    v = await buildRecallVault();
    const base = fakeClient([
      { tool: 'entityLookup', args: { query: 'Ada' } },
      { tool: 'claimsForEntity', args: { entity: v.adaRel } },
      { tool: 'submitAnswer', args: { answer: 'Ada Lovelace, the first programmer [1].', citations: [{ kind: 'claim', ref: v.claimRel, label: 'first programmer' }], grounded: true } },
    ]);
    const models: (string | undefined)[] = [];
    const client: RecallClient = {
      async createSession(config) {
        models.push(config.model);
        if (config.model !== 'auto') throw new Error('Model "claude-opus-4" from --model flag is not available.');
        return base.client.createSession(config);
      },
      async disconnect(): Promise<void> {},
    };
    const res = await recall(v.root, 'Who was Ada Lovelace?', { client, model: 'claude-opus-4', now: fixedNow });
    expect(models).toEqual(['claude-opus-4', 'auto']); // pinned rejected → retried once with auto
    expect(res.grounded).toBe(true); // the auto retry produced the grounded answer
    expect(res.citations[0]?.ref).toBe(v.claimRel);
  });

  it('does NOT retry on a non-model session error — honest ungrounded, one attempt (ASK-7)', async () => {
    v = await buildRecallVault();
    const models: (string | undefined)[] = [];
    const client: RecallClient = {
      async createSession(config): Promise<never> {
        models.push(config.model);
        throw new Error('copilot CLI unavailable'); // not a model rejection → must not auto-retry
      },
      async disconnect(): Promise<void> {},
    };
    const res = await recall(v.root, 'q', { client, model: 'claude-opus-4', now: fixedNow });
    expect(models).toEqual(['claude-opus-4']); // single attempt — no spurious auto-retry
    expect(res.grounded).toBe(false);
  });

  it('drops citations that do not resolve on disk → not grounded (ASK-7 honesty)', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([
      { tool: 'submitAnswer', args: { answer: 'Made up.', citations: [{ kind: 'claim', ref: 'claims/person/ghost.md' }], grounded: true } },
    ]);
    const res = await recall(v.root, 'q', { client, now: fixedNow });
    expect(res.citations).toEqual([]);
    expect(res.grounded).toBe(false);
  });

  it('enforces the tool-call budget (F3): retrieval degrades past the cap, run is truncated', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([
      { tool: 'grep', args: { pattern: 'a' } },
      { tool: 'grep', args: { pattern: 'b' } },
      { tool: 'grep', args: { pattern: 'c' } }, // past cap → exhausted nudge, truncated
      { tool: 'submitAnswer', args: { answer: 'Partial.', citations: [] } },
    ]);
    const res = await recall(v.root, 'q', { client, maxToolCalls: 2, now: fixedNow });
    expect(res.toolCalls).toBe(2); // never exceeds the cap
    expect(res.truncated).toBe(true);
    expect(res.grounded).toBe(false);
  });

  it('never throws when the SDK/CLI is unavailable — honest ungrounded result', async () => {
    v = await buildRecallVault();
    const failing: RecallClient = {
      async createSession(): Promise<never> {
        throw new Error('copilot CLI unavailable');
      },
    };
    const res = await recall(v.root, 'q', { client: failing, now: fixedNow });
    expect(res.grounded).toBe(false);
    expect(res.answer).toContain('copilot CLI unavailable');
    expect(res.trace?.ok).toBe(false);
    expect(res.trace?.error).toContain('copilot CLI unavailable');
  });

  it('truncates honestly when the agent never submits an answer', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([{ tool: 'entityLookup', args: { query: 'Ada' } }]); // no submitAnswer
    const res = await recall(v.root, 'q', { client, now: fixedNow });
    expect(res.grounded).toBe(false);
    expect(res.truncated).toBe(true);
    expect(res.toolCalls).toBe(1);
  });

  it('is read-only w.r.t. the ontology (ASK-3): no source/entity/claim file changes', async () => {
    v = await buildRecallVault();
    const before = await snapshot(v.root, ['sources', 'entities', 'claims']);
    const { client } = fakeClient([
      { tool: 'entityLookup', args: { query: 'Ada' } },
      { tool: 'grep', args: { pattern: 'engine' } },
      { tool: 'submitAnswer', args: { answer: 'x', citations: [{ kind: 'entity', ref: v.adaRel }], grounded: true } },
    ]);
    await recall(v.root, 'q', { client, now: fixedNow });
    expect(await snapshot(v.root, ['sources', 'entities', 'claims'])).toEqual(before);
  });

  it('uses the default read-only tools + real clock when not injected', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([
      { tool: 'entityLookup', args: { query: 'Ada' } },
      { tool: 'submitAnswer', args: { answer: 'A', citations: [{ kind: 'entity', ref: v.adaRel }], grounded: true } },
    ]);
    const res = await recall(v.root, 'q', { client }); // no tools, no now → defaults
    expect(res.grounded).toBe(true);
    expect(res.toolCalls).toBe(1);
    const audit = JSON.parse((await fs.readFile(path.join(v.root, '.kb', 'cache', 'ask', 'audit.jsonl'), 'utf8')).trim());
    expect(typeof audit.ts).toBe('string');
  });

  it('skips the audit write when audit:false', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([{ tool: 'submitAnswer', args: { answer: 'x', citations: [] } }]);
    await recall(v.root, 'q', { client, now: fixedNow, audit: false });
    expect(await pathExists(path.join(v.root, '.kb', 'cache', 'ask', 'audit.jsonl'))).toBe(false);
  });

  it('buildRecallToolDefs: retrieval wrappers count + serialize, degrade past cap; submitAnswer captures', async () => {
    v = await buildRecallVault();
    const tools = makeReadOnlyTools(v.root);
    const captured = { answered: false, answer: '', citations: [] as Citation[], declaredGrounded: true };
    const budget = { used: 0, truncated: false };
    const defs = buildRecallToolDefs(tools, captured, budget, 1);

    const lookup = defs.find((d) => d.name === 'entityLookup')!;
    const first = await lookup.handler({ query: 'Ada' });
    expect(typeof first).toBe('string'); // serialized JSON the agent reads
    expect(JSON.parse(first as string).some((e: { rel: string }) => e.rel === v!.adaRel)).toBe(true);
    expect(budget.used).toBe(1);

    const second = await lookup.handler({ query: 'Ada' }); // past the cap of 1
    expect(String(second).toLowerCase()).toContain('budget exhausted');
    expect(budget.truncated).toBe(true);
    expect(budget.used).toBe(1); // not incremented past the cap

    const submit = defs.find((d) => d.name === 'submitAnswer')!;
    await submit.handler({ answer: 'hi', citations: [{ kind: 'claim', ref: 'claims/x.md' }], grounded: true });
    expect(captured.answered).toBe(true);
    expect(captured.answer).toBe('hi');
    expect(captured.citations).toHaveLength(1);
  });

  // Regression (CANON-8/9): recall runs against the vault ROOT — the `main` checkout Obsidian
  // browses. Its transparency audit is workflow machinery, not evergreen knowledge, so it must
  // land in the gitignored working zone and leave the tree clean (it previously wrote an
  // untracked `.kb/ask/audit.jsonl`, leaving the user's vault perpetually git-dirty).
  it('a recall run leaves the evergreen working tree clean (CANON-8/9)', async () => {
    const root = await makeTempDir('kb-recall-clean-');
    try {
      // A REAL git-backed vault with the production .gitignore (couples this test to the real
      // ignore template — if `.kb/cache/` ever stops being ignored, this fails).
      const created = await createKb({ path: root, name: 'clean', initGitIfNeeded: true });
      expect(created.ok).toBe(true);
      const git = simpleGit(root);
      expect((await git.status()).isClean()).toBe(true); // baseline: createKb committed everything

      const { client } = fakeClient([{ tool: 'submitAnswer', args: { answer: 'x', citations: [], grounded: false } }]);
      await recall(root, 'who is Atlas?', { client, now: fixedNow });

      // The audit was written to the gitignored working zone…
      expect(await pathExists(path.join(root, '.kb', 'cache', 'ask', 'audit.jsonl'))).toBe(true);
      // …and NOT to the tracked evergreen root.
      expect(await pathExists(path.join(root, '.kb', 'ask', 'audit.jsonl'))).toBe(false);
      // …so the `main` checkout the Principal browses stays clean (no untracked machinery state).
      expect((await git.status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });
});

/** Snapshot path→content for every file under the given subdirs (to prove read-only). */
async function snapshot(root: string, subdirs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function rec(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else out[path.relative(root, full)] = await fs.readFile(full, 'utf8');
    }
  }
  for (const s of subdirs) await rec(path.join(root, s));
  return out;
}

// ── Retrieval budget scaling (F3 / dogfood #5) ────────────────────────────────────────────────
describe('recallBudget — scales the tool-call cap to graph size (dogfood #5; ASK-19 raise BASE 2→4, MAX 16→24)', () => {
  it('the raised bounds are pinned (regression: BASE 4, MAX 24)', () => {
    expect(RECALL_BUDGET.BASE).toBe(4);
    expect(RECALL_BUDGET.MAX).toBe(24);
    expect(RECALL_BUDGET.MIN).toBe(4);
    expect(RECALL_BUDGET.BASE).toBeGreaterThan(2); // the old base was too tight (Principal-reported)
    expect(RECALL_BUDGET.MAX).toBeGreaterThan(16); // the old ceiling capped real grounded recall
  });

  it('clamps to MIN for a tiny/empty KB (no over-budget looping)', () => {
    expect(recallBudget(0)).toBe(RECALL_BUDGET.MIN); // 4 + 0 = 4
    expect(recallBudget(-5)).toBe(RECALL_BUDGET.MIN); // defensive: negative → MIN
  });

  it('scales in the middle from the raised BASE (every query starts with more search room)', () => {
    expect(recallBudget(1)).toBe(5); // 4 + ceil(0.5*1)=1 → 5
    expect(recallBudget(6)).toBe(7); // 4 + ceil(0.5*6)=3 → 7
    expect(recallBudget(10)).toBe(9); // 4 + 5 → 9
    expect(recallBudget(28)).toBe(18); // 4 + 14 = 18 — the OLD MAX(16) would have capped here; now headroom
    expect(recallBudget(28)).toBeLessThan(RECALL_BUDGET.MAX); // a mid-large KB still has room below the cap
  });

  it('clamps to the raised MAX (24) only for a large KB (keeps headroom, never unbounded)', () => {
    expect(recallBudget(40)).toBe(RECALL_BUDGET.MAX); // 4 + ceil(0.5*40)=20 → 24
    expect(recallBudget(1000)).toBe(RECALL_BUDGET.MAX);
  });

  it('is monotonic non-decreasing in nodeCount, plateauing at the cap', () => {
    let prev = 0;
    for (let n = 0; n <= 60; n++) {
      const b = recallBudget(n);
      expect(b).toBeGreaterThanOrEqual(prev);
      expect(b).toBeLessThanOrEqual(RECALL_BUDGET.MAX);
      prev = b;
    }
  });
});

describe('countEntityNodes — entity-graph size for the budget', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rmTempDir(dir);
  });

  it('counts entities/**/*.md recursively, ignores other trees + dotdirs, 0 when absent', async () => {
    dir = await makeTempDir();
    const root = path.join(dir, 'v');
    await createKb({ path: root, initGitIfNeeded: true });
    expect(await countEntityNodes(root)).toBe(0); // fresh KB: no entity nodes yet

    await fs.mkdir(path.join(root, 'entities', 'person'), { recursive: true });
    await fs.mkdir(path.join(root, 'entities', 'org'), { recursive: true });
    await fs.writeFile(path.join(root, 'entities', 'person', 'ada-lovelace.md'), '# Ada');
    await fs.writeFile(path.join(root, 'entities', 'person', 'charles-babbage.md'), '# Charles');
    await fs.writeFile(path.join(root, 'entities', 'org', 'mit.md'), '# MIT');
    await fs.writeFile(path.join(root, 'entities', 'person', 'notes.txt'), 'not md'); // ignored
    await fs.mkdir(path.join(root, 'entities', '.cache'), { recursive: true });
    await fs.writeFile(path.join(root, 'entities', '.cache', 'x.md'), 'dotdir ignored'); // ignored
    // a claim file must NOT be counted (entities are the graph nodes, claims are leaves)
    await fs.mkdir(path.join(root, 'claims', 'person'), { recursive: true });
    await fs.writeFile(path.join(root, 'claims', 'person', 'c.md'), '# claim');

    expect(await countEntityNodes(root)).toBe(3);
  });
});

// ── ASK-13: inline numbered citations — verify + dedup + dense renumber ───────────────────────────
describe('finalizeCitations (ASK-13) — dense, deduped, verified [n] ↔ citations[n-1]', () => {
  let v: RecallVault | undefined;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
    v = undefined;
  });

  it('renumbers inline [n] to be dense + 1:1, deduping a repeated ref to one number', async () => {
    v = await buildRecallVault();
    const tools = makeReadOnlyTools(v.root);
    const raw: Citation[] = [
      { kind: 'claim', ref: v.claimRel },
      { kind: 'entity', ref: v.adaRel },
      { kind: 'claim', ref: v.claimRel }, // duplicate of [1]
    ];
    const { answer, citations } = await finalizeCitations(tools, 'Ada [1] is a programmer [2][3].', raw);
    expect(citations).toHaveLength(2); // dup collapsed
    expect(citations[0].ref).toBe(v.claimRel);
    expect(citations[1].ref).toBe(v.adaRel);
    expect(answer).toBe('Ada [1] is a programmer [2][1].'); // [3] reused [1]'s number
  });

  it('drops a marker whose citation does not resolve, then renumbers the survivors densely (ASK-7)', async () => {
    v = await buildRecallVault();
    const tools = makeReadOnlyTools(v.root);
    const raw: Citation[] = [
      { kind: 'claim', ref: 'claims/person/does-not-exist.md' }, // unresolvable → dropped
      { kind: 'entity', ref: v.adaRel }, // resolvable → becomes [1]
    ];
    const { answer, citations } = await finalizeCitations(tools, 'A [1] and B [2].', raw);
    expect(citations).toHaveLength(1);
    expect(citations[0].ref).toBe(v.adaRel);
    expect(answer).toBe('A  and B [1].'); // [1] dropped (unresolvable), [2] → [1]
  });

  it('flows through recall(): the result carries dense markers + matching citations', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([
      {
        tool: 'submitAnswer',
        args: {
          answer: 'Ada Lovelace [1] worked on the Analytical Engine [2], and is the first programmer [1].',
          citations: [
            { kind: 'claim', ref: v.claimRel },
            { kind: 'entity', ref: v.engineRel },
          ],
          grounded: true,
        },
      },
    ]);
    const res = await recall(v.root, 'Tell me about Ada', { client, now: fixedNow });
    expect(res.grounded).toBe(true);
    expect(res.citations.map((c) => c.ref)).toEqual([v.claimRel, v.engineRel]);
    expect(res.answer).toContain('[1]');
    expect(res.answer).toContain('[2]');
    // No dangling marker beyond the citation count.
    expect(res.answer).not.toMatch(/\[3\]/);
  });
});

// ASK-16 — recall is interactive-priority: it acquires a slot from the GLOBAL copilot pool (no longer
// bypassing the safety ceiling) through the priority lane, held across the SDK session, and fails fast
// + honestly when capacity can't be granted in bound instead of hanging to the 60s session.idle timeout.
describe('recall is interactive-priority (ASK-16)', () => {
  let v: RecallVault | undefined;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
    v = undefined;
  });

  it('acquires a (priority) capacity slot BEFORE opening the session and releases it AFTER — no bypass', async () => {
    v = await buildRecallVault();
    const events: string[] = [];
    const acquireSlot = async (): Promise<() => void> => {
      events.push('acquire');
      return () => events.push('release');
    };
    const base = fakeClient([
      { tool: 'submitAnswer', args: { answer: 'Ada [1].', citations: [{ kind: 'claim', ref: v.claimRel }], grounded: true } },
    ]);
    const client: RecallClient = {
      ...base.client,
      async createSession(config) {
        events.push('session');
        return base.client.createSession(config);
      },
    };
    const res = await recall(v.root, 'Who was Ada?', { client, acquireSlot, now: fixedNow });
    expect(res.grounded).toBe(true); // the session ran (while the slot was held)
    expect(events).toEqual(['acquire', 'session', 'release']); // acquired BEFORE, released AFTER
  });

  it('fails FAST + honestly when capacity is denied (bounded) — never opens a session, no 60s hang', async () => {
    v = await buildRecallVault();
    let sessionOpened = false;
    const client: RecallClient = {
      async createSession() {
        sessionOpened = true;
        throw new Error('should not be reached');
      },
      async disconnect(): Promise<void> {},
    };
    const acquireSlot = async (): Promise<() => void> => {
      throw new CopilotCapacityTimeoutError(30_000); // pool saturated/wedged → bounded denial
    };
    const res = await recall(v.root, 'Who was Ada?', { client, acquireSlot, now: fixedNow });
    expect(sessionOpened).toBe(false); // failed fast — never spawned an out-of-bound session
    expect(res.grounded).toBe(false);
    expect(res.answer).toMatch(/busy ingesting/i); // honest, retryable — not a silent hang
    expect(res.trace?.ok).toBe(false);
  });

  it('waits for a freed slot then resolves (saturated pool, granted within bound)', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([
      { tool: 'submitAnswer', args: { answer: 'Ada [1].', citations: [{ kind: 'claim', ref: v.claimRel }], grounded: true } },
    ]);
    // The priority acquire resolves only after a background op frees the slot (a tick later).
    const acquireSlot = async (): Promise<() => void> => {
      await new Promise((r) => setTimeout(r, 5));
      return () => {};
    };
    const res = await recall(v.root, 'Who was Ada?', { client, acquireSlot, now: fixedNow });
    expect(res.grounded).toBe(true); // got the slot promptly, then answered
  });
});

// ASK-17 — recall has a real, CONFIGURABLE work budget (not a hard 60s) + returns an honest grounded
// partial on exhaustion. ASK-16 fixed capacity; the bottleneck then moved to session-completion: the
// SDK session timed out at 60s before the agent finished a grounded multi-hop over a large KB.
describe('recall work budget (ASK-17)', () => {
  let v: RecallVault | undefined;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
    v = undefined;
  });

  // A client that records the timeout `sendAndWait` was called with, then scripts a grounded answer.
  function budgetRecordingClient(answerCitationRef: string): { client: RecallClient; timeout: () => number | undefined } {
    let received: number | undefined;
    const client: RecallClient = {
      async createSession(config) {
        const byName = new Map((config.tools ?? []).map((t) => [t.name, t]));
        return {
          async sendAndWait(_prompt: string, timeoutMs?: number): Promise<unknown> {
            received = timeoutMs;
            await byName.get('submitAnswer')!.handler({ answer: 'Answer [1].', citations: [{ kind: 'claim', ref: answerCitationRef }], grounded: true }, {});
            return { type: 'assistant.message' };
          },
          async disconnect(): Promise<void> {},
        };
      },
      async disconnect(): Promise<void> {},
    };
    return { client, timeout: () => received };
  }

  it('passes the CONFIGURED budget to the SDK session (a query needing > the old 60s gets room)', async () => {
    v = await buildRecallVault();
    const rec = budgetRecordingClient(v.claimRel);
    const res = await recall(v.root, 'Who was Ada?', { client: rec.client, sessionBudgetMs: 180_000, now: fixedNow });
    expect(rec.timeout()).toBe(180_000); // the raised budget reached the SDK, not the hard 60s
    expect(res.grounded).toBe(true);
  });

  it('defaults the budget WELL ABOVE the old 60s when the caller does not specify one', async () => {
    v = await buildRecallVault();
    const rec = budgetRecordingClient(v.claimRel);
    await recall(v.root, 'Who was Ada?', { client: rec.client, now: fixedNow });
    expect(rec.timeout()).toBe(DEFAULT_RECALL_BUDGET_MS);
    expect(DEFAULT_RECALL_BUDGET_MS).toBeGreaterThan(60_000);
  });

  it('on budget exhaustion AFTER a partial answer, returns the grounded PARTIAL + honest "incomplete" — not a bare throw', async () => {
    v = await buildRecallVault();
    const client: RecallClient = {
      async createSession(config) {
        const byName = new Map((config.tools ?? []).map((t) => [t.name, t]));
        return {
          async sendAndWait(): Promise<unknown> {
            // The agent submits a grounded partial, then the session runs out of budget mid-exploration.
            await byName.get('submitAnswer')!.handler({ answer: 'You stayed in Tulum [1].', citations: [{ kind: 'claim', ref: v!.claimRel }], grounded: true }, {});
            throw new Error('Timeout after 240000ms waiting for session.idle');
          },
          async disconnect(): Promise<void> {},
        };
      },
      async disconnect(): Promise<void> {},
    };
    const res = await recall(v.root, 'where did i stay in mexico in 2025', { client, now: fixedNow });
    expect(res.grounded).toBe(true); // the captured partial WAS grounded — not discarded
    expect(res.citations).toHaveLength(1);
    expect(res.truncated).toBe(true); // flagged incomplete
    expect(res.answer).toMatch(/incomplete|ran out of time/i); // honest note appended (ORCH-7)
    expect(res.answer).toContain('Tulum'); // the partial answer is preserved
  });

  it('on budget exhaustion with NOTHING captured, returns an honest ungrounded result (never throws)', async () => {
    v = await buildRecallVault();
    const client: RecallClient = {
      async createSession(): Promise<import('./recall').RecallSession> {
        return {
          async sendAndWait(): Promise<unknown> {
            throw new Error('Timeout after 240000ms waiting for session.idle'); // timed out before any answer
          },
          async disconnect(): Promise<void> {},
        };
      },
      async disconnect(): Promise<void> {},
    };
    const res = await recall(v.root, 'an impossible question', { client, now: fixedNow });
    expect(res.grounded).toBe(false);
    expect(res.truncated).toBe(true);
    expect(res.answer).toMatch(/couldn't reach a grounded answer in time/i); // honest, retryable — not a throw
  });
});

// ASK-18 — recall length/effort ADAPTS to the question (concise for facts, fuller for open-ended;
// always cited). The behaviour lives in the agent (LLM) shaped by the recall SKILL, so the real-path
// regression has two halves: (1) the prompt-contract the REAL agent receives carries the adaptive
// instruction (the lever — prompt-faithful, not a hand-injected verdict); (2) the recall pipeline
// carries BOTH a fuller multi-section answer AND a terse one through intact + cited (never truncating
// a rich answer, never dropping citations). No LLM runs in CI, so these pin the scaffolding that makes
// adaptation possible — the exact thing a regression would silently break.
describe('recall — adaptive length & effort (ASK-18)', () => {
  let v: RecallVault | undefined;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
    v = undefined;
  });

  it('the recall skill instructs the agent to scale length to the question — terse fact vs fuller open-ended, always cited', async () => {
    v = await buildRecallVault();
    const { client, lastConfig } = fakeClient([{ tool: 'submitAnswer', args: { answer: 'x', citations: [], grounded: false } }]);
    await recall(v.root, 'q', { client, now: fixedNow });
    const skill = lastConfig()?.systemMessage?.content ?? '';
    expect(skill).toContain('ADAPTIVE LENGTH & EFFORT (ASK-18)');
    expect(skill).toMatch(/SIMPLE \/ FACTUAL[\s\S]*TIGHT, DIRECT/); // a fact → tight, direct
    expect(skill).toMatch(/OPEN-ENDED \/ EXPLORATORY[\s\S]*FULLER/); // open-ended → fuller, multi-paragraph
    expect(skill).toMatch(/MORE grounded detail, never less grounding/); // cite REGARDLESS (ASK-7/13 kept)
  });

  it('carries an open-ended question’s FULLER multi-section answer through intact + grounded — never truncated', async () => {
    v = await buildRecallVault();
    const fuller = [
      '## Overview',
      'Ada Lovelace is regarded as the first computer programmer [1].',
      '',
      '## Her work',
      'She wrote the first published algorithm intended for a machine [1].',
      '',
      '## Significance',
      'Her notes anticipated ideas central to general-purpose computing [1].',
    ].join('\n');
    const { client } = fakeClient([
      { tool: 'entityLookup', args: { query: 'Ada' } },
      { tool: 'claimsForEntity', args: { entity: v.adaRel } },
      { tool: 'submitAnswer', args: { answer: fuller, citations: [{ kind: 'claim', ref: v.claimRel, label: 'first programmer' }], grounded: true } },
    ]);
    const res = await recall(v.root, 'What do we know about Ada Lovelace and her work?', { client, now: fixedNow });

    expect(res.grounded).toBe(true);
    // The fuller answer survives end-to-end — multi-section, not collapsed to one line.
    expect(res.answer).toContain('## Overview');
    expect(res.answer).toContain('## Her work');
    expect(res.answer).toContain('## Significance');
    expect(res.answer.split('\n').filter((l) => l.startsWith('## ')).length).toBeGreaterThanOrEqual(3);
    expect(res.citations).toHaveLength(1); // still cited — fuller means MORE grounded detail, kept
    expect(res.answer).toContain('[1]'); // inline citation marker preserved (ASK-13)
  });

  it('keeps a simple factual question’s answer terse + cited — not padded into the open-ended shape', async () => {
    v = await buildRecallVault();
    const terse = 'Ada Lovelace is regarded as the first computer programmer [1].';
    const { client } = fakeClient([
      { tool: 'entityLookup', args: { query: 'Ada' } },
      { tool: 'submitAnswer', args: { answer: terse, citations: [{ kind: 'claim', ref: v.claimRel, label: 'first programmer' }], grounded: true } },
    ]);
    const res = await recall(v.root, 'Who was Ada Lovelace?', { client, now: fixedNow });

    expect(res.grounded).toBe(true);
    expect(res.citations).toHaveLength(1); // still cited
    expect(res.answer).not.toContain('##'); // stayed terse — no padded multi-section structure
    expect(res.answer.length).toBeLessThan(120); // a sentence or two, not an essay
  });
});

// #514 — Ask responsiveness batch (deep review 2026-07-12): live progress, bounded prompt bytes,
// windowed tool results, and the trace recording the model/effort that actually ran.
describe('recall — live progress events (#514)', () => {
  let v: RecallVault | undefined;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
    v = undefined;
  });

  it('fires onProgress synchronously on each retrieval tool call, naming the tool + running count', async () => {
    v = await buildRecallVault();
    const events: Array<{ phase: string; tool?: string; used: number; max: number }> = [];
    const { client } = fakeClient([
      { tool: 'entityLookup', args: { query: 'Ada' } },
      { tool: 'claimsForEntity', args: { entity: v.adaRel } },
      { tool: 'submitAnswer', args: { answer: 'x [1]', citations: [{ kind: 'claim', ref: v.claimRel }], grounded: true } },
    ]);
    await recall(v.root, 'q', { client, now: fixedNow, onProgress: (e) => events.push(e) });

    // submitAnswer is not a retrieval call — only the two retrieval tools emit progress.
    expect(events).toEqual([
      { phase: 'tool-call', tool: 'entityLookup', used: 1, max: expect.any(Number) },
      { phase: 'tool-call', tool: 'claimsForEntity', used: 2, max: expect.any(Number) },
    ]);
  });

  it('fires a budget-exhausted progress event when a call is degraded past the cap', async () => {
    v = await buildRecallVault();
    const events: Array<{ phase: string }> = [];
    const { client } = fakeClient([
      { tool: 'entityLookup', args: { query: 'Ada' } },
      { tool: 'entityLookup', args: { query: 'Ada' } }, // past the cap of 1 → degrades
      { tool: 'submitAnswer', args: { answer: 'x', citations: [], grounded: false } },
    ]);
    await recall(v.root, 'q', { client, now: fixedNow, maxToolCalls: 1, onProgress: (e) => events.push(e) });
    expect(events.map((e) => e.phase)).toEqual(['tool-call', 'budget-exhausted']);
  });

  it('never calling onProgress is fine — it is optional and never awaited/blocking', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([{ tool: 'entityLookup', args: { query: 'Ada' } }, { tool: 'submitAnswer', args: { answer: 'x', citations: [], grounded: false } }]);
    await expect(recall(v.root, 'q', { client, now: fixedNow })).resolves.toBeDefined();
  });
});

describe('recall — bounded prompt bytes independent of conversation length (#514)', () => {
  let v: RecallVault | undefined;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
    v = undefined;
  });

  it('caps a 20-turn history to the last 10, noting how many were omitted', async () => {
    v = await buildRecallVault();
    const history = Array.from({ length: 20 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
    const { client } = fakeClient([{ tool: 'submitAnswer', args: { answer: 'x', citations: [], grounded: false } }]);
    // Capture the actual prompt sent — sendAndWait's first arg.
    let sentPrompt = '';
    const capturingClient: RecallClient = {
      async createSession(config) {
        const real = await client.createSession(config);
        return {
          ...real,
          sendAndWait: async (prompt: string, timeoutMs?: number) => {
            sentPrompt = prompt;
            return real.sendAndWait(prompt, timeoutMs);
          },
        };
      },
    };
    await recall(v.root, { question: 'the new question', history }, { client: capturingClient, now: fixedNow });

    expect(sentPrompt).toContain('10 earlier turn(s) omitted for length');
    expect(sentPrompt).not.toContain('q0\n'); // the oldest 10 turns are gone
    expect(sentPrompt).not.toContain('q9\n');
    expect(sentPrompt).toContain('q10'); // the most recent 10 survive
    expect(sentPrompt).toContain('q19');
    expect(sentPrompt).toContain('the new question');
  });

  it('caps each surviving turn’s text so K turns × per-turn-cap is a real constant bound, not just a turn-count cap', async () => {
    v = await buildRecallVault();
    const hugeAnswer = 'x'.repeat(50_000);
    const history = [{ question: 'q', answer: hugeAnswer }];
    const { client } = fakeClient([{ tool: 'submitAnswer', args: { answer: 'x', citations: [], grounded: false } }]);
    let sentPrompt = '';
    const capturingClient: RecallClient = {
      async createSession(config) {
        const real = await client.createSession(config);
        return { ...real, sendAndWait: async (prompt: string, timeoutMs?: number) => ((sentPrompt = prompt), real.sendAndWait(prompt, timeoutMs)) };
      },
    };
    await recall(v.root, { question: 'q2', history }, { client: capturingClient, now: fixedNow });
    expect(sentPrompt.length).toBeLessThan(hugeAnswer.length); // the 50KB answer did NOT pass through whole
    expect(sentPrompt).toContain('…[truncated]');
  });
});

describe('recall — no single tool result exceeds the 32KB bound (#514)', () => {
  let v: RecallVault | undefined;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
    v = undefined;
  });

  it('windows a >32KB tool result (head + tail) with an honest truncation note, well under 32KB', async () => {
    v = await buildRecallVault();
    const tools = makeReadOnlyTools(v.root);
    const captured = { answered: false, answer: '', citations: [] as Citation[], declaredGrounded: true };
    const budget = { used: 0, truncated: false };
    // A fake tool surface whose readSource returns a 5MB "file" (the exact PERF-A6 class: readSource
    // returns whole files into context).
    const bigTools: typeof tools = { ...tools, readSource: async () => 'y'.repeat(5 * 1024 * 1024) };
    const defs = buildRecallToolDefs(bigTools, captured, budget, 10);
    const readSource = defs.find((d) => d.name === 'readSource')!;

    const out = (await readSource.handler({ dir: 'sources/whatever' })) as string;
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(32 * 1024);
    expect(out).toContain('truncated');
    expect(out).toContain('32KB per-call bound');
  });

  it('a small tool result passes through byte-identical (no windowing when under the bound)', async () => {
    v = await buildRecallVault();
    const tools = makeReadOnlyTools(v.root);
    const captured = { answered: false, answer: '', citations: [] as Citation[], declaredGrounded: true };
    const budget = { used: 0, truncated: false };
    const defs = buildRecallToolDefs(tools, captured, budget, 10);
    const lookup = defs.find((d) => d.name === 'entityLookup')!;
    const out = (await lookup.handler({ query: 'Ada' })) as string;
    expect(out).not.toContain('truncated');
    expect(JSON.parse(out).some((e: { rel: string }) => e.rel === v!.adaRel)).toBe(true);
  });
});

describe('recall — trace records the model + effort that actually ran (#514)', () => {
  let v: RecallVault | undefined;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
    v = undefined;
  });

  it('records the requested model + effort label on a normal run', async () => {
    v = await buildRecallVault();
    const { client } = fakeClient([{ tool: 'submitAnswer', args: { answer: 'x', citations: [], grounded: false } }]);
    const res = await recall(v.root, 'q', { client, now: fixedNow, model: 'claude-haiku-4.5', effort: 'quick' });
    expect(res.trace?.model).toBe('claude-haiku-4.5');
    expect(res.trace?.effort).toBe('quick');
  });

  it('records the model that ACTUALLY ran (auto), not the stale pin, after the pre-flight fallback retry', async () => {
    v = await buildRecallVault();
    const base = fakeClient([{ tool: 'submitAnswer', args: { answer: 'x', citations: [], grounded: false } }]);
    const client: RecallClient = {
      async createSession(config) {
        if (config.model !== 'auto') throw new Error('Model "claude-opus-4" from --model flag is not available.');
        return base.client.createSession(config);
      },
    };
    const res = await recall(v.root, 'q', { client, now: fixedNow, model: 'claude-opus-4', effort: 'considered' });
    expect(res.trace?.model).toBe('auto'); // the trace is honest about what ACTUALLY ran
    expect(res.trace?.effort).toBe('considered');
  });

  it('forwards reasoningEffort to the SDK session config when set', async () => {
    v = await buildRecallVault();
    const { client, lastConfig } = fakeClient([{ tool: 'submitAnswer', args: { answer: 'x', citations: [], grounded: false } }]);
    await recall(v.root, 'q', { client, now: fixedNow, reasoningEffort: 'low' });
    expect(lastConfig()?.reasoningEffort).toBe('low');
  });
});
