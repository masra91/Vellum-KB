import { describe, it, expect } from 'vitest';
import { versionFromTag, tagMatchesPackageVersion } from './tagVersion.mjs';

describe('versionFromTag (#529 RELEASE-6 — the tag/package.json version guardrail)', () => {
  it('strips the leading v from a stable tag', () => {
    expect(versionFromTag('v0.2.0')).toBe('0.2.0');
  });
  it('strips the leading v from a dry-run/-rc tag, keeping the full prerelease suffix', () => {
    expect(versionFromTag('v0.2.0-rc.1')).toBe('0.2.0-rc.1');
  });
  it('is a no-op when the tag has no leading v (defensive, should not normally happen)', () => {
    expect(versionFromTag('0.2.0')).toBe('0.2.0');
  });
});

describe('tagMatchesPackageVersion', () => {
  it('matches when the tag (minus v) equals the committed package.json version', () => {
    expect(tagMatchesPackageVersion('v0.2.0', '0.2.0')).toBe(true);
  });
  it('does NOT match a stale package.json version (the release must be blocked, not silently rewritten)', () => {
    expect(tagMatchesPackageVersion('v0.2.0', '0.1.0')).toBe(false);
  });
  it('matches a dry-run -rc tag against an identical prerelease package.json version', () => {
    expect(tagMatchesPackageVersion('v0.2.0-rc.1', '0.2.0-rc.1')).toBe(true);
  });
  it('does NOT match a stable tag against a prerelease package.json version (fails-before: a loose prefix match would wrongly pass)', () => {
    expect(tagMatchesPackageVersion('v0.2.0', '0.2.0-rc.1')).toBe(false);
  });
});
