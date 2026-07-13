// SPEC-0027 PANEL-3 — Agents view-model. Node tier (pure; the DOM view is covered by jobsView-style tests).
import { describe, it, expect } from 'vitest';
import { AGENT_CATALOG, buildAgentViews, type AgentCatalogEntry, type AgentLiveContext } from './agentCatalog';

describe('buildAgentViews (PANEL-3)', () => {
  // SPEC-0048: a per-agent resolver (an agent's own pin → global → floor); '' → "Copilot (default)".
  const all = (m: string): AgentLiveContext => ({ resolveModel: () => m, pipelineActive: true });

  it('lists the librarian/stage agents with role + instruction pointer', () => {
    const views = buildAgentViews(AGENT_CATALOG, all('claude-opus-4.8'));
    expect(views.map((v) => v.key)).toEqual(['archivist', 'decompose', 'connect', 'claims', 'compose', 'recall', 'reflect']);
    for (const v of views) {
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.role.length).toBeGreaterThan(0);
      expect(v.instructions).toMatch(/^kb\//);
    }
  });

  it('shows each agent the model it resolves to (per-agent), Copilot default when empty', () => {
    expect(buildAgentViews(AGENT_CATALOG, all('gpt-x'))[0].model).toBe('gpt-x');
    expect(buildAgentViews(AGENT_CATALOG, all(''))[0].model).toBe('Copilot (default)');
  });

  it('resolves PER-AGENT — a different model per key + surfaces the configured pick (SPEC-0048)', () => {
    const ctx: AgentLiveContext = {
      resolveModel: (k) => (k === 'connect' ? 'claude-sonnet-4.5' : 'claude-opus-4.8'),
      configuredModels: { connect: 'claude-sonnet-4.5' },
      pipelineActive: true,
    };
    const views = buildAgentViews(AGENT_CATALOG, ctx);
    expect(views.find((v) => v.key === 'connect')?.model).toBe('claude-sonnet-4.5');
    expect(views.find((v) => v.key === 'connect')?.configuredModel).toBe('claude-sonnet-4.5');
    expect(views.find((v) => v.key === 'decompose')?.model).toBe('claude-opus-4.8'); // unset → global
    expect(views.find((v) => v.key === 'decompose')?.configuredModel).toBeUndefined();
  });

  it('marks a deterministic agent’s model accordingly', () => {
    const catalog: AgentCatalogEntry[] = [{ key: 'det', label: 'Det', role: 'r', instructions: 'kb/x.ts', agentBacked: false }];
    expect(buildAgentViews(catalog, all('gpt-x'))[0].model).toBe('deterministic');
  });

  it('reflects live status: running when the pipeline is active, else idle (PANEL-9)', () => {
    expect(buildAgentViews(AGENT_CATALOG, all('m'))[0].status).toBe('running');
    expect(buildAgentViews(AGENT_CATALOG, { resolveModel: () => 'm', pipelineActive: false })[0].status).toBe('idle');
  });
});
