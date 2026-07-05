---
spec: SPEC-0061
key: REFIT
title: Functional Rethink — v3 flows ↔ backend fit
type: architecture
status: draft
owners: [KB-Lead, KB-Architect, Principal]
created: 2026-06-29
updated: 2026-06-29
related: [SPEC-0060, SPEC-0058, SPEC-0050, SPEC-0007, SPEC-0014, SPEC-0026, SPEC-0048, SPEC-0010]
supersedes: null
---

# Functional Rethink — v3 flows ↔ backend fit

> The v3 UX (SPEC-0060) promises a product the current backend only partly supports. This spec maps
> each surface's intended flow against backend reality (evidenced), and sorts the changes needed into
> **no-regret moves** vs **bigger structural bets** — so we change the foundation deliberately, one
> piece at a time. This is a thinking/decision surface, not a build order yet.

**The one immovable post:** all LLM egress stays on the **GitHub Copilot SDK/CLI** (the Principal's
token subs). Everything else is on the table — branching/git strategy, new local data stores, agent
prompts, deterministic behaviors. The trigger for this spec was Reviews: a flow specced in SPEC-0060
(VUX-13, agent-set options) shipped as a *visual reskin only* — the backend answer model never moved.
That gap is the pattern we're getting ahead of.

## 1. The three architectural truths (current state, evidenced)

**T1 — Reads are projection-fast, but there is no queryable index, so the two heaviest reads re-walk
the whole vault.** There is **no DB, no search index, no embeddings** anywhere — vault is markdown +
JSONL + JSON caches. The SPEC-0058 `ProjectionStore` (status / reviews / graph / today) keeps Today /
Reviews / Explore / Status **instant** (off git/fs). But: **Health live-scans the vault on every
mount** (the graph projection that fixes it exists — `ipc.ts:610`, a one-line swap never made); and
**Recall/Ask re-walks all entities + all claims on *every tool-call, every question*** and ignores the
in-memory graph it could use (`recall.ts`, `recallTools.ts`). Every "find / filter / search" is an
O(vault) file walk. Push is unwired (views poll a 2.5–8 s cadence; `onUpdate` + the
`refreshGraph/Today` invalidation seams exist but are never called) → up to 8 s staleness.

**T2 — Every durable write serializes through one canonical git lock + commit.** A single per-vault
`Mutex` (`stageLock.ts`) guards the ref-advance for all stages, schedulers, capture, and interactive
write-backs; work is prepared off-lock in per-item worktrees (optimistic advance, cherry-pick replay,
3× collision retry → set-aside; `canonicalAdvance.ts`). `staging → main` promotion is the sole writer
of the evergreen vault and is **coalesced** (30 s quiet / 180 s max). Reads are off git (T1). The
contention is concentrated and low-risk: **fast config/UI writes share the canonical lock** with the
pipeline; **capture awaits a git commit before it acks**; **save-output and Health remediate do an
*inline* promote** under the lock (review-answer already avoids this — fast verdict-write, heavy
effects deferred via `void runAnsweredReviewEffects`).

**T3 — The interaction model is closed at the edges but extensible underneath.** The IPC surface is
binary (`REVIEW_VERDICTS = ['confirm','reject']`, a single `recall-answer` Output type). But beneath it
is a ready typed-effect substrate: **7 content-keyed directive families** under `directives/`
(disambiguation / consolidation / retract / reattribute / guidance / enrich / contradiction), evergreen,
last-wins, with a **generic `revoke {family,targetKey}`** undo — plus the precedent that **answering a
review with a note already captures it as a primary Source** (`captureToInbox(root,'review-note',…)`).
Richer interactions should write into this typed-effect log, not extend the closed verdict union.

## 2. Per-surface: intended flow → backend fit → lever

Axis tags: **[data]** responsiveness/store · **[git]** write/promotion · **[prompt]** agent prompt ·
**[det]** deterministic behavior · **[model]** review/interaction model.

| Surface | Intended v3 flow (SPEC-0060) | Backend fit today | Lever |
|---|---|---|---|
| **Today** | flow-strip + needs-you + recent activity + health glance | GOOD (projections) — but Today composite live-scans health+activity each cadence | N1, N5 **[data]** |
| **Ask** | continued conversation · Quick/Considered (depth) · Past-chats · Save-to-KB menu | PARTIAL — effort + past-chats **shipped**; recall re-walks vault per tool-call (slow); only one Output type | N2 **[data]**, B3 **[model]** |
| **Capture** | quiet capture, staged files, instant | GOOD — but awaits a git commit before ack | B4 **[git]** |
| **Reviews** | **agent-set options · >2 candidates · custom buttons** | **NOT SUPPORTED** — binary verdict; candidates display-only (reskin shipped, model didn't) | **B2 [model]** |
| **Explore** | entity graph · full map · edge/claim/confidence meaning | graph projection good when warm; `exploreNeighborhood` cold-falls-back to live scan; claim/confidence semantics underspecified | N5, B1 **[data]**; claims-model = own session |
| **Health** | remediation (relink/find-homes/enrich/merge) · dismiss · why-it-matters | dismiss + non-destructive remediation **shipped** (#498/#500); view live-scans vault each mount; merge/enrich deferred/blocked | N1 **[data]** + finish actions |
| **Agents / Researchers** | low-config/high-info · drill-in with past-runs timeline · de-jargon | last-dispatch state exists; a full per-agent **run-history** store is needed for the drill-in | run-history **[data]**, **[prompt]** |
| **Connectors** | guided connect-a-source (RSS/M365) | feeds + watch exist (sourcesView) — mostly view work | view; maybe M365→Researcher **(IA)** |
| **Settings** | global prefs · watched folders · advanced caps | exists; config writes share the canonical git lock | N3 **[git]** |
| **Guidance** | directives surface · create from Reviews + Explore | **backend EXISTS** (7 families + revoke), **no UI**, "correct this" unwired | build surface (SPEC-0050 §4) + wire create paths **[model]** |
| **Save-to-KB / Outputs** | raw transcript · summarized note · synthesized entity | single `recall-answer` Output type; one inline-promote write | B3 **[model]**, N4 **[git]** |

## 3. The cross-cutting bets

### 3a. No-regret moves (low risk, clear win — do regardless of the bigger rethink)
- **N1 — Health → graph projection.** Swap `buildHealthReport(makeReadOnlyTools)` for the existing
  projection; kills the per-mount vault scan (`ipc.ts:610`). One-line-ish.
- **N2 — Recall reads the index, not the vault.** Point recall's tool surface at the in-memory graph
  (today) / the index (B1) instead of `makeReadOnlyTools` live walks per tool-call. Biggest latency win
  in "effortless recall out"; budget buys reasoning, not I/O. (`makeProjectionTools` is the drop-in seam.)
- **N3 — Move fast config/UI writes off the canonical git lock.** Model/panel/settings are app state,
  not knowledge — a separate store/lock removes them from pipeline contention.
- **N4 — Route interactive write-backs through the promote coalescer.** Save-output and Health return on
  the staging commit (like review-answer); drop the inline `promote`.
- **N5 — Wire real projection push + canonical-advance invalidation.** Call the existing (unused)
  refresh seams on advance; replace 2.5–8 s blind staleness with immediate reflect; enables true push.

### 3b. Bigger structural bets (need a decision)
- **B1 — A real local indexed store** (lexical FTS + entity/claim/backlink/text tables) as the query
  substrate for recall / health / search / explore. Generalizes the graph projection from one O(vault)
  recompute into incremental indexed queries. The foundational responsiveness + scale bet; unlocks
  several surfaces at once. **[data]**
- **B2 — Open the review answer model.** Replace the closed `REVIEW_VERDICTS` union with an **agent-
  defined option set** on the review (`options[]: {id,label,action}`), candidates become selectable when
  it's a pick-one, ">2" falls out, and the chosen option writes into the **directive/typed-effect log +
  revoke** (T3) and can graduate to Guidance. Backward-compat: confirm/reject = the default 2-option set.
  This is the specced VUX-13 — the thing the Principal actually wanted from Reviews. **[model]**
- **B3 — Save-to-KB output types** (raw transcript / summarized note / synthesized entity) on the Outputs
  seam, reusing the note→primary-source precedent. **[model]**
- **B4 — Capture write-ahead log.** Ack on a durable WAL write, commit asynchronously — decouples quick-
  capture latency from lock contention. Single biggest lever for the "quick capture in" promise. **[git]**
- **B5 — Determinism layer.** Born-resolved fast-paths (e.g. `connectOne`), a **code-repair pass ahead
  of LLM self-repair**, and schema/lint guards pre/post-LLM — fewer LLM calls, more reliability,
  cheaper. Especially valuable under the GHCP-only constraint. **[det]**
- **B6 — Finer-grained / batched advance** (sharded path-range lock or K-item batched commits) — **only
  if** write throughput becomes the bottleneck. Flagged, not yet justified. **[git]**

## 4. What the GHCP-SDK-fixed constraint implies

Egress is GHCP SDK only, so B1 cannot lean on a vendor embeddings API. The local index should be
**lexical + structural** (FTS + the graph/backlink tables we already compute), not vector search — or
embeddings must come from an on-device/deterministic model. Model tiering stays `--model`-only
(`resolveCopilotModel`). Net: the constraint pushes us *toward* determinism (B5) and lexical/graph
indexing (B1) — which is arguably the right shape for a provenance-first KB anyway (explainable retrieval
over opaque vectors). Capability gaps route through DEV-3 (SDK) or get solved locally.

## 5. Recommended first cut (not a commitment)

1. **Responsiveness + write-contention cleanup (N1–N5)** — pure wins, mostly small; makes the *current*
   app feel instant. Do soon regardless.
2. **B2 (Reviews-as-options)** — the contained functional capability the Principal asked for; well-seam'd
   on the directive log. First "functional, not visual" slice.
3. **B1 (local index)** — the foundational bet; do it deliberately (it's a dependency + a migration). N2
   collapses into it.
4. **B3 / B5** ride on B1/B2. **B4** whenever capture latency is felt. **B6** only if measured.

## 6. Requirements (proposed — addressable IDs for the decisions, not yet committed)

| ID | Priority | Statement (short) | Verify |
|---|---|---|---|
| REFIT-1 | should | Health reads a projection, not a render-path vault scan | none-yet |
| REFIT-2 | should | Recall reads the in-memory graph/index, not per-tool-call vault walks | none-yet |
| REFIT-3 | should | Fast config/UI writes do not share the canonical git lock | none-yet |
| REFIT-4 | should | Interactive write-backs return on the staging commit (no inline promote) | none-yet |
| REFIT-5 | should | Projections invalidate on canonical-advance (push, not blind cadence) | none-yet |
| REFIT-6 | may | A local lexical+structural index backs recall/health/search/explore (B1) | none-yet |
| REFIT-7 | may | Reviews carry an agent-defined option set written to the directive log (B2; = VUX-13) | none-yet |
| REFIT-8 | may | Save-to-KB supports multiple output types (B3) | none-yet |
| REFIT-9 | may | Capture acks on a WAL, commits async (B4) | none-yet |
| REFIT-10 | may | A deterministic guard/repair layer fronts LLM deciders where feasible (B5) | none-yet |

## 7. Open questions

- [ ] Per-surface flows still to pin: Capture richer intake, Connectors-vs-Researcher for M365, the
  Explore **claims/links/confidence model** (already flagged for its own zoom-out session, SPEC-0060 §9).
- [ ] B1 dependency choice (e.g. `better-sqlite3`) — E1 supply-chain review (reputable, pinned, ≥7-day);
  or a pure-TS FTS to avoid a native dep (mac-package risk, per the externalize-native-deps lessons).
- [ ] Agent run-history store shape (for the Agents drill-in past-runs timeline).
- [ ] The "you" identity node data model (SPEC-0060 §7).

## 8. Changelog

- 2026-06-29 — created (draft). Grounded in a three-axis backend investigation (data/responsiveness,
  git/promotion/concurrency, pipeline/prompts/interaction). Triggered by the Reviews reskin-vs-functional
  gap. GHCP-SDK reliance fixed as the one constraint.
