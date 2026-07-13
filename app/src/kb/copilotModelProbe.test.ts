import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseAcceptedModels,
  selectPreferredModel,
  probeAcceptedModels,
  initLaunchModel,
  validateModel,
  resolveStageDefaultModels,
  STAGE_MODEL_PREFERENCES,
  DEFAULT_MODEL_PREFERENCES,
  LAST_RESORT_MODEL,
} from './copilotModelProbe';
import { resolveCopilotModel, setResolvedLaunchModel, setStageDefaultModels, DEFAULT_COPILOT_MODEL, COPILOT_MODEL_AUTO } from './copilotModel';

// A faithful slice of real `copilot help config` output (CLI 1.0.62) — the accepted-model catalog.
const HELP_CONFIG = `Configuration Settings

  \`autoModelSwitch\`: switch to auto on rate limits.
    - When \`true\`, eligible rate limit errors trigger an automatic switch to auto mode and retry

  \`model\`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.
    - "claude-sonnet-4.6"
    - "claude-sonnet-4.5"
    - "claude-haiku-4.5"
    - "claude-opus-4.8"
    - "claude-opus-4.7"
    - "claude-opus-4.5"
    - "gpt-5.5"

  \`contextTier\`: context window tier for tiered-pricing models.
    - "default"
`;

afterEach(() => {
  setResolvedLaunchModel(null); // clear the module-level resolved cache between tests
  setStageDefaultModels({}); // INGEST-PERF item 4: clear the per-stage defaults between tests
});

describe('parseAcceptedModels (probe the CLI catalog from `copilot help config`)', () => {
  it('extracts the quoted model ids under the `model` key, in document order', () => {
    expect(parseAcceptedModels(HELP_CONFIG)).toEqual([
      'claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-haiku-4.5',
      'claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.5', 'gpt-5.5',
    ]);
  });
  it('stops at the next config key (does not bleed into contextTier values)', () => {
    expect(parseAcceptedModels(HELP_CONFIG)).not.toContain('default');
  });
  it('returns [] when the model section is absent / the format shifted', () => {
    expect(parseAcceptedModels('totally different help text')).toEqual([]);
    expect(parseAcceptedModels('')).toEqual([]);
  });
});

describe('selectPreferredModel (ORCH-28 — preference list vs the accepted set)', () => {
  const prefs = ['claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.5', 'claude-sonnet-4.5'];

  it('picks the TOP preference when the CLI accepts it (no degradation)', () => {
    expect(selectPreferredModel(prefs, ['claude-opus-4.8', 'claude-opus-4.5'])).toEqual({
      model: 'claude-opus-4.8', degraded: false, reason: 'preferred',
    });
  });
  it('DEGRADES to a lower preference when the top is absent (visible signal)', () => {
    const sel = selectPreferredModel(prefs, ['claude-opus-4.5', 'claude-sonnet-4.5']);
    expect(sel).toEqual({ model: 'claude-opus-4.5', degraded: true, reason: 'degraded', wanted: 'claude-opus-4.8' });
  });
  it('falls to `auto` as the LAST RESORT when no preference is accepted', () => {
    const sel = selectPreferredModel(prefs, ['gpt-5.5', 'gemini-3.1-pro-preview']);
    expect(sel).toEqual({ model: LAST_RESORT_MODEL, degraded: true, reason: 'last-resort', wanted: 'claude-opus-4.8' });
  });
  it('trusts the top preference when the probe is INCONCLUSIVE (accepted=null) — never blocks on a probe miss', () => {
    expect(selectPreferredModel(prefs, null)).toEqual({ model: 'claude-opus-4.8', degraded: false, reason: 'preferred' });
  });
  it('the in-app default preference list leads with the newest Opus, never bare `auto`', () => {
    expect(DEFAULT_MODEL_PREFERENCES[0]).toBe('claude-opus-4.8');
    expect(DEFAULT_MODEL_PREFERENCES).not.toContain('auto'); // auto is the implicit last resort, never a listed preference
  });
  it('LAST_RESORT_MODEL matches the shared `auto` constant', () => {
    expect(LAST_RESORT_MODEL).toBe(COPILOT_MODEL_AUTO);
  });
});

describe('probeAcceptedModels (one cheap `help config` spawn)', () => {
  it('returns the parsed catalog from the injected runner', async () => {
    const run = vi.fn(async () => HELP_CONFIG);
    expect(await probeAcceptedModels(run)).toContain('claude-opus-4.8');
    expect(run).toHaveBeenCalledWith(['help', 'config']);
  });
  it('returns null when the CLI errors (unavailable) — caller falls back', async () => {
    expect(await probeAcceptedModels(async () => { throw new Error('copilot not found'); })).toBeNull();
  });
  it('returns null when the catalog cannot be parsed (format shift)', async () => {
    expect(await probeAcceptedModels(async () => 'no model section here')).toBeNull();
  });
});

describe('initLaunchModel (startup resolution + visible degradation — ORCH-28)', () => {
  it('publishes the top-preference model and logs `model.resolved` when accepted', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const sel = await initLaunchModel({ run: async () => HELP_CONFIG, log });
    expect(sel.model).toBe('claude-opus-4.8'); // top of the default list, accepted by the catalog
    expect(resolveCopilotModel({})).toBe('claude-opus-4.8'); // deciders now pick this up
    expect(log.info).toHaveBeenCalledWith('model.resolved', expect.objectContaining({ model: 'claude-opus-4.8' }));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('WARNs `model.degraded` and publishes the fallback when the top preference is unavailable', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    // Catalog lacks every preference → last-resort auto.
    const sel = await initLaunchModel({ run: async () => '  `model`: AI model\n    - "gpt-5.5"\n', log });
    expect(sel.reason).toBe('last-resort');
    expect(resolveCopilotModel({})).toBe(COPILOT_MODEL_AUTO);
    expect(log.warn).toHaveBeenCalledWith('model.degraded', expect.objectContaining({ model: 'auto', wanted: 'claude-opus-4.8' }));
  });

  it('honors a config-overridden preference list', async () => {
    await initLaunchModel({ preferences: ['claude-sonnet-4.5', 'claude-opus-4.8'], run: async () => HELP_CONFIG });
    expect(resolveCopilotModel({})).toBe('claude-sonnet-4.5'); // first of the overridden list that the catalog accepts
  });

  it('leaves the floor pin in place when the probe fails (never blocks startup)', async () => {
    const sel = await initLaunchModel({ run: async () => { throw new Error('CLI gone'); } });
    expect(sel.model).toBe(DEFAULT_MODEL_PREFERENCES[0]); // accepted=null → trust top preference
    // resolveCopilotModel returns the published top preference (the probe was inconclusive, not failed-to-floor)
    expect(resolveCopilotModel({})).toBe(DEFAULT_MODEL_PREFERENCES[0]);
  });

  it('the eval KB_COPILOT_MODEL override still wins over the probed model', async () => {
    await initLaunchModel({ run: async () => HELP_CONFIG });
    expect(resolveCopilotModel({ KB_COPILOT_MODEL: 'gpt-5.5' })).toBe('gpt-5.5');
  });

  it('the interim floor is unchanged for code that reads it directly', () => {
    expect(DEFAULT_COPILOT_MODEL).toBe('claude-opus-4.5');
  });
});

describe('SPEC-0048 — validated config model override (Agents-view picker)', () => {
  it('a user override the CLI ACCEPTS wins over the preference list', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const sel = await initLaunchModel({ override: 'gpt-5.5', run: async () => HELP_CONFIG, log });
    expect(sel.model).toBe('gpt-5.5'); // honored (it's in the catalog), not the opus-4.8 top preference
    expect(resolveCopilotModel({})).toBe('gpt-5.5');
    expect(log.info).toHaveBeenCalledWith('model.resolved', expect.objectContaining({ model: 'gpt-5.5', source: 'config-override' }));
  });

  it('a user override the CLI REJECTS is refused (WARN) and falls back to the preference list — never hard-breaks', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    // claude-opus-4.6 is NOT in HELP_CONFIG → rejected → fall to the preference-list top (opus-4.8).
    const sel = await initLaunchModel({ override: 'claude-opus-4.6', run: async () => HELP_CONFIG, log });
    expect(sel.model).toBe('claude-opus-4.8');
    expect(resolveCopilotModel({})).toBe('claude-opus-4.8');
    expect(log.warn).toHaveBeenCalledWith('model.override-rejected', expect.objectContaining({ wanted: 'claude-opus-4.6' }));
  });

  it("an override is honored when the probe is INCONCLUSIVE (can't prove it invalid; per-call auto net still guards)", async () => {
    const sel = await initLaunchModel({ override: 'some-future-model', run: async () => { throw new Error('CLI gone'); } });
    expect(sel.model).toBe('some-future-model');
    expect(resolveCopilotModel({})).toBe('some-future-model');
  });

  it('validateModel classifies a pick against the live catalog (accepted / rejected / unknown)', async () => {
    expect((await validateModel('claude-opus-4.8', async () => HELP_CONFIG)).result).toBe('accepted');
    expect((await validateModel('claude-opus-4.6', async () => HELP_CONFIG)).result).toBe('rejected'); // not in the catalog
    expect((await validateModel('anything', async () => { throw new Error('no CLI'); })).result).toBe('unknown');
  });
});

describe('INGEST-PERF item 4 — per-stage default model resolution', () => {
  it('the tiered stages map to their right-sized cheap tier when the catalog accepts it', () => {
    const accepted = parseAcceptedModels(HELP_CONFIG); // includes haiku + sonnet + opus
    const defaults = resolveStageDefaultModels(accepted);
    expect(defaults).toEqual({
      archivist: 'claude-haiku-4.5', // fastest/cheapest — Archive normalizes/stores
      decompose: 'claude-sonnet-4.6', // fast — self-contained parse of one source
      claims: 'claude-sonnet-4.6', // low–medium — bounded source-local extraction
    });
    // Strong stages get NO per-stage entry → they fall through to the global default.
    expect(defaults.connect).toBeUndefined();
    expect(defaults.compose).toBeUndefined();
  });

  it('a cheap-tier id absent from the catalog DEGRADES down its list to a known-good model (never bricks)', () => {
    // Catalog has sonnet + opus but NOT haiku → Archive degrades haiku→sonnet-4.6 (next in its list).
    const noHaiku = ['claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-opus-4.8'];
    expect(resolveStageDefaultModels(noHaiku).archivist).toBe('claude-sonnet-4.6');
    // Catalog has ONLY opus → every tiered stage degrades down to opus-4.8 (the strong fallback tail).
    const onlyOpus = ['claude-opus-4.8', 'claude-opus-4.7'];
    expect(resolveStageDefaultModels(onlyOpus)).toEqual({
      archivist: 'claude-opus-4.8', decompose: 'claude-opus-4.8', claims: 'claude-opus-4.8',
    });
  });

  it('an INCONCLUSIVE probe trusts each stage top preference (per-call auto net still guards)', () => {
    const defaults = resolveStageDefaultModels(null);
    expect(defaults.archivist).toBe('claude-haiku-4.5');
    expect(defaults.decompose).toBe('claude-sonnet-4.6');
    expect(defaults.claims).toBe('claude-sonnet-4.6');
  });

  it('initLaunchModel publishes the per-stage defaults so deciders resolve their cheap tier', async () => {
    await initLaunchModel({ run: async () => HELP_CONFIG });
    expect(resolveCopilotModel({}, 'archivist')).toBe('claude-haiku-4.5');
    expect(resolveCopilotModel({}, 'decompose')).toBe('claude-sonnet-4.6');
    expect(resolveCopilotModel({}, 'claims')).toBe('claude-sonnet-4.6');
    expect(resolveCopilotModel({}, 'connect')).toBe('claude-opus-4.8'); // strong stage → global probed model
  });

  it('a user GLOBAL override CLEARS the per-stage defaults — every stage defers to the explicit pick', async () => {
    await initLaunchModel({ override: 'gpt-5.5', run: async () => HELP_CONFIG });
    expect(resolveCopilotModel({}, 'archivist')).toBe('gpt-5.5'); // not the cheap haiku default
    expect(resolveCopilotModel({}, 'claims')).toBe('gpt-5.5');
    expect(resolveCopilotModel({}, 'connect')).toBe('gpt-5.5');
  });

  it('STAGE_MODEL_PREFERENCES only tiers the three cheap stages; each list ends with the strong Opus tail', () => {
    expect(Object.keys(STAGE_MODEL_PREFERENCES).sort()).toEqual(['archivist', 'claims', 'decompose']);
    for (const list of Object.values(STAGE_MODEL_PREFERENCES)) {
      expect(list[list.length - 1]).toBe(DEFAULT_MODEL_PREFERENCES[DEFAULT_MODEL_PREFERENCES.length - 1]); // strong fallback tail
    }
  });
});
