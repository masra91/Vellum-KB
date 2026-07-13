// SPEC-0026 ASK-4/ASK-12 + SPEC-0030 BUG #65 — the recall skill + the Copilot-SDK client adapter.
// The SDK is mocked so we can assert the adapter's wiring (esp. that the BYOA `cliPath` reaches the
// CopilotClient connection) without spawning the CLI.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({ ctorArgs: [] as unknown[], forStdioArgs: [] as unknown[], stopCalls: 0 }));

vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: class {
    constructor(opts?: unknown) {
      sdk.ctorArgs.push(opts);
    }
    async createSession(): Promise<{ sendAndWait: () => Promise<unknown>; disconnect: () => Promise<void> }> {
      return { sendAndWait: async () => ({}), disconnect: async () => {} };
    }
    async stop(): Promise<void> {
      sdk.stopCalls++;
    }
  },
  RuntimeConnection: {
    forStdio: (o: unknown) => {
      sdk.forStdioArgs.push(o);
      return { kind: 'stdio', ...(o as object) };
    },
  },
  defineTool: (name: string, cfg: Record<string, unknown>) => ({ name, ...cfg }),
  approveAll: {},
}));

import { RECALL_SKILL, RECALL_SKILL_VERSION, makeSdkRecallClient } from './recallAgent';

beforeEach(() => {
  sdk.ctorArgs.length = 0;
  sdk.forStdioArgs.length = 0;
  sdk.stopCalls = 0;
});

describe('recall skill (ASK-4)', () => {
  it('teaches KB structure, grounding, and the submitAnswer finish protocol', () => {
    expect(RECALL_SKILL).toContain('Vellum Recall agent');
    expect(RECALL_SKILL).toContain('KB STRUCTURE');
    expect(RECALL_SKILL).toContain('GROUNDING');
    expect(RECALL_SKILL).toContain('submitAnswer');
    expect(RECALL_SKILL).toMatch(/tags/); // metadata-aware (SPEC-0025 META)
    expect(RECALL_SKILL).toMatch(/STOP once you have gathered ENOUGH/); // shape-aware budget stop-criterion (#113 / ASK-18)
    expect(RECALL_SKILL).toMatch(/\[1\], \[2\]/); // inline numbered citations (ASK-13)
    // ASK-18: adaptive length/effort — terse for facts, fuller for open-ended, cite regardless.
    expect(RECALL_SKILL).toContain('ADAPTIVE LENGTH & EFFORT (ASK-18)');
    expect(RECALL_SKILL).toMatch(/SIMPLE \/ FACTUAL[\s\S]*TIGHT, DIRECT/);
    expect(RECALL_SKILL).toMatch(/OPEN-ENDED \/ EXPLORATORY[\s\S]*FULLER/);
    expect(RECALL_SKILL).toMatch(/never less grounding/);
    expect(RECALL_SKILL_VERSION).toBe('recall/v5-sdk'); // #113 + ASK-13 + ASK-18 adaptive length
  });
});

describe('makeSdkRecallClient (ASK-12 substrate + BUG #65 cliPath)', () => {
  it('returns a RecallClient seam without spawning the CLI (lazy)', () => {
    const client = makeSdkRecallClient({ model: 'gpt-5' });
    expect(typeof client.createSession).toBe('function');
    expect(typeof client.disconnect).toBe('function');
    expect(sdk.ctorArgs).toHaveLength(0); // no CopilotClient constructed until createSession
  });

  it('wires the BYOA cliPath into the SDK connection (BUG #65 — recall works in the packaged app)', async () => {
    const client = makeSdkRecallClient({ cliPath: '/abs/path/copilot' });
    await client.createSession({ tools: [], systemMessage: { mode: 'append', content: 'x' }, allowedTools: [] });
    expect(sdk.forStdioArgs).toContainEqual({ path: '/abs/path/copilot' });
    expect(sdk.ctorArgs[0]).toMatchObject({ connection: { kind: 'stdio', path: '/abs/path/copilot' } });
  });

  it('constructs the client with no connection when cliPath is absent (SDK default search)', async () => {
    const client = makeSdkRecallClient({});
    await client.createSession({ tools: [] });
    expect(sdk.forStdioArgs).toHaveLength(0);
    expect(sdk.ctorArgs[0]).toEqual({});
  });

  // #514: recall.ts previously built a FRESH RecallClient per question — every `createSession` therefore
  // constructed a NEW CopilotClient (a new `copilot` CLI server process), never stopped. The fix is
  // reusing ONE RecallClient across questions (wired in ipc.ts); this pins the underlying guarantee that
  // makes that reuse actually work — the SAME RecallClient instance across multiple createSession calls
  // constructs the CopilotClient exactly ONCE (lazily, on the first call) and shares it thereafter.
  it('reuses the SAME underlying CopilotClient across multiple createSession calls (2nd+ question skips the server boot)', async () => {
    const client = makeSdkRecallClient({ cliPath: '/abs/path/copilot' });
    await client.createSession({ tools: [] });
    await client.createSession({ tools: [] });
    await client.createSession({ tools: [] });
    expect(sdk.ctorArgs).toHaveLength(1); // ONE CopilotClient (= one CLI server) for three questions
  });

  it('disconnect() is a no-op when no session was ever created (nothing to stop, never throws)', async () => {
    const client = makeSdkRecallClient({});
    await expect(client.disconnect?.()).resolves.toBeUndefined();
    expect(sdk.stopCalls).toBe(0);
  });

  it('disconnect() stops the underlying CopilotClient once it was lazily constructed — this is what actually releases the leaked CLI server (#514)', async () => {
    const client = makeSdkRecallClient({});
    await client.createSession({ tools: [] }); // lazily constructs the CopilotClient
    await client.disconnect?.();
    expect(sdk.stopCalls).toBe(1);
  });
});
