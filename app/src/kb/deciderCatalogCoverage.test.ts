// #528 ENG-8 gate (deep review 2026-07-12): every decider built on the shared launch scaffold
// (deciderScaffold.ts — archivist/decompose/claims/compose/connect/reflect) must (a) have a live
// AGENT_CATALOG entry, else its Settings model pin + Agents-view row is dead (the #528 bug 1 class —
// compose shipped without one), and (b) actually attach an `agent: AgentTrace` on a successful run,
// else Agents/audit provenance silently goes missing (the #528 bug 2 class — reflect built none at
// all). Centralizing this as one cross-cutting regression means a future 7th decider that forgets
// either wiring fails HERE, immediately, rather than surfacing as a dead Settings control months later.
//
// Each fixture below runs the decider's REAL factory with an injected runner (the repo QA bar — no
// mocking the decider itself), matching the exact minimal-valid input/stdout shape each decider's own
// test file already exercises.
import { describe, it, expect } from 'vitest';
import { AGENT_CATALOG } from './agentCatalog';
import { makeDecomposeDecider, type SourceInput } from './decomposeAgent';
import { makeClaimsDecider, type EntityInput } from './claimsAgent';
import { makeComposeDecider, type ComposeInput } from './composeAgent';
import { makeConnectDecider, type CandidateSet } from './connectAgent';
import { makeReflectDecider, type ReflectContext } from './reflectAgent';
import { makeCopilotDecider } from './copilotAgent';
import type { CapturedMeta } from './ingest';

interface DeciderFixture {
  agentKey: string;
  invoke: () => Promise<{ agent?: { via?: string } }>;
}

const FIXTURES: DeciderFixture[] = [
  {
    agentKey: 'archivist',
    invoke: async () => {
      const meta: CapturedMeta = {
        id: '01JABCDEF7Q2ABCDEFGHJKMNPQ',
        kind: 'text',
        raw: 'raw.txt',
        contentHash: 'sha256:abc',
        capturedAt: '2026-05-30T18:22:04.000Z',
        surface: 'in-app-panel',
        captureBatch: '01JB00000000000000000BATCH',
        mimeType: 'text/plain',
      };
      const decider = makeCopilotDecider({
        available: true,
        run: async () => '{"kind":"text","class":"primary","scope":"global","sensitivity":"internal"}',
      });
      return decider(meta);
    },
  },
  {
    agentKey: 'decompose',
    invoke: () => {
      const input: SourceInput = { sourceId: '01JSRC', kind: 'text', text: 'call Steve re: Q3 budget' };
      const decider = makeDecomposeDecider({
        available: true,
        run: async () => '{"sourceId":"01JSRC","entities":[{"kind":"person","name":"Steve","confidence":0.9,"mentions":["call Steve"]}]}',
      });
      return decider(input);
    },
  },
  {
    agentKey: 'claims',
    invoke: () => {
      const input: EntityInput = {
        entityId: '01JENT',
        kind: 'person',
        name: 'Steve',
        source: { sourceId: '01JSRC', kind: 'text', text: 'Steve owns the Q3 budget and visited the Austin site.' },
      };
      const decider = makeClaimsDecider({
        available: true,
        run: async () => '{"entityId":"01JENT","claims":[{"statement":"Owns the Q3 budget.","status":"interpretation","confidence":0.7,"mentions":["Steve owns the Q3 budget"]}]}',
      });
      return decider(input);
    },
  },
  {
    agentKey: 'compose',
    invoke: () => {
      const input: ComposeInput = {
        entityId: '01JENT',
        kind: 'person',
        name: 'Steve Jobs',
        claims: [{ statement: 'Co-founded Apple in 1976.', title: 'Apple keynote notes (2026-05-30)' }],
        links: [],
      };
      const decider = makeComposeDecider({
        available: true,
        run: async () => '{"sections":[{"sentences":[{"text":"Steve Jobs co-founded Apple.","claims":[1]}]}]}',
      });
      return decider(input);
    },
  },
  {
    agentKey: 'connect',
    invoke: () => {
      const set: CandidateSet = {
        blockKey: 'person|steve jobs',
        kind: 'person',
        candidates: [{ id: '01A', sourceId: '01S1', kind: 'person', name: 'Steve Jobs', confidence: 0.8, mentions: ['Steve Jobs'] }],
        existingNodes: [],
      };
      const decider = makeConnectDecider({
        available: true,
        run: async () => '{"blockKey":"person|steve jobs","clusters":[{"canonicalName":"Steve Jobs","memberCandidateIds":["01A"],"confidence":0.9}]}',
      });
      return decider(set);
    },
  },
  {
    agentKey: 'reflect',
    invoke: () => {
      const ctx: ReflectContext = { workingSet: [], journalNotes: [] };
      const decider = makeReflectDecider({ available: true, run: async () => '{"inspected":"ran","findings":[]}' });
      return decider(ctx);
    },
  },
];

describe('decider scaffold coverage (#528 gate)', () => {
  it.each(FIXTURES)('$agentKey has a live AGENT_CATALOG entry', ({ agentKey }) => {
    expect(AGENT_CATALOG.some((a) => a.key === agentKey)).toBe(true);
  });

  it.each(FIXTURES)('$agentKey attaches an AgentTrace on a successful run', async ({ invoke }) => {
    const result = await invoke();
    expect(result.agent?.via).toBeDefined();
  });
});
