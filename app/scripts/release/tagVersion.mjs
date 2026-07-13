// SPEC-0055 slice 1 (#529) — the release workflow's version guardrail. "Version bumps via `npm
// version` PR" (the issue's suggested approach) is the source of truth: a human bumps package.json's
// version in a normal PR to main, THEN tags that merged commit. This module does not rewrite
// package.json — it only ASSERTS the tag and the already-committed version agree, so a release can
// never publish an artifact whose `getAppVersion()` (already shipped, kb:getAppVersion → app.getVersion())
// silently disagrees with the tag that triggered it (RELEASE-6). Pure + CLI-wrapped so the matching
// rule itself is unit-tested, not just exercised end-to-end in CI.
import { readFileSync } from 'node:fs';

/** Strip the leading `v` a release tag always carries (`v0.2.0` → `0.2.0`, `v0.2.0-rc.1` → `0.2.0-rc.1`). */
export function versionFromTag(tag) {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

/** True when the tag's version (minus its leading `v`) exactly matches the committed package.json
 *  version — the single source of truth is the `npm version` PR, not this check rewriting anything. */
export function tagMatchesPackageVersion(tag, packageVersion) {
  return versionFromTag(tag) === packageVersion;
}

function main() {
  const tag = process.argv[2];
  if (!tag) {
    console.error('usage: node tagVersion.mjs <tag>');
    process.exit(2);
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (!tagMatchesPackageVersion(tag, pkg.version)) {
    console.error(
      `::error::Tag ${tag} (version ${versionFromTag(tag)}) does not match package.json's committed version ` +
        `(${pkg.version}). Bump the version via an \`npm version\` PR to main FIRST, then tag that merged ` +
        `commit — the release workflow never rewrites package.json for you.`,
    );
    process.exit(1);
  }
  console.log(`OK: tag ${tag} matches package.json version ${pkg.version}.`);
}

// Only run the CLI when invoked directly (`node tagVersion.mjs ...`), not when imported for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
