# Spec Index

The registry of every living spec. New specs reserve the next `SPEC-NNNN` number
and a unique `key` here.

## Conventions
- **Spec numbers** are sequential and never reused.
- **Keys** are short, uppercase, unique; they namespace requirement IDs (`KEY-N`).
- Keep this table sorted by spec number.

## Specs

| Spec      | Key     | Title                       | Type    | Status | Folder      |
| --------- | ------- | --------------------------- | ------- | ------ | ----------- |
| SPEC-0000 | SPECSYS | The Living Spec System      | meta    | active | `./`        |
| SPEC-0001 | LANG    | Ubiquitous Language (Glossary) | product | draft  | `product/`  |
| SPEC-0002 | PRIN    | Knowledge System Principles | product | draft  | `product/`  |
| SPEC-0003 | VISION  | Product Vision & The Core Loop | product | draft | `product/` |
| SPEC-0004 | LIFE    | KB Lifecycle & Capabilities    | product | draft | `product/` |
| SPEC-0005 | SCOPE   | Contexts, Scopes & Surfacing   | product | draft | `product/` |
| SPEC-0006 | AUTO    | Agent Autonomy & Approval      | product | draft | `product/` |
| SPEC-0007 | DATA    | Core Data Model (Sources/Entities/Outputs) | product | draft | `product/` |
| SPEC-0008 | INGEST  | Ingestion Pipeline (Ingest spine)          | feature | draft | `features/` |
| SPEC-0009 | SETUP   | First-Run / KB Setup (first build story)   | feature | draft | `features/` |
| SPEC-0010 | STACK   | Tech Stack & App Shell Architecture        | architecture | draft | `architecture/` |
| SPEC-0011 | ENG     | Engineering Principles & Rules             | architecture | active | `architecture/` |
| SPEC-0012 | TEST    | Testing Strategy                           | architecture | active | `architecture/` |
| SPEC-0013 | CAPTURE | Simple Capture (v1)                        | feature | draft | `features/` |
| SPEC-0014 | ORCH    | Orchestration & Pipeline Engine            | architecture | draft | `architecture/` |
| SPEC-0015 | DECOMP  | Decompose (Enrich v1)                      | feature | draft | `features/` |
| SPEC-0016 | CLAIMS  | Claims (Enrich v2)                         | feature | draft | `features/` |
| SPEC-0017 | SHELL   | App Navigation Shell                        | architecture | draft | `architecture/` |
| SPEC-0018 | REVIEW  | Review & Disambiguation ("needs you" queue) | feature | draft | `features/` |
| SPEC-0019 | CANON   | Evergreen Canonical & Working-State Isolation | architecture | draft | `architecture/` |
| SPEC-0020 | CONNECT | Connect & Expand (Enrich v3)                | feature | draft | `features/` |
| SPEC-0021 | STAGING | Staging Branch & Promotion Gate             | architecture | draft | `architecture/` |
| SPEC-0022 | REPLAY  | Replay & Reprocessing (full rebuild v1)     | feature | draft | `features/` |
| SPEC-0023 | JOBS    | Autonomous Jobs & Scheduler                 | architecture | draft | `architecture/` |
| SPEC-0024 | REFLECT | Reflect & Rumination (self-maintenance v1)  | feature | draft | `features/` |
| SPEC-0025 | META    | Rich Metadata, Tags & Properties            | feature | draft | `features/` |
| SPEC-0026 | ASK     | Ask & Recall (grounded NL query v1)         | feature | draft | `features/` |
| SPEC-0027 | PANEL   | Control Panel (manage agents, sources & jobs) | feature | draft | `features/` |
| SPEC-0028 | RESEARCH | Researchers (Enrich & Research)            | feature | draft | `features/` |
| SPEC-0029 | AUDIT   | Audit & Activity (lineage + read-only views) | feature | draft | `features/` |
| SPEC-0030 | OBS     | Pipeline Status & Diagnostics (status view + dev logs) | feature | draft | `features/` |
| SPEC-0031 | VAULT   | Obsidian Vault Representation (the human view) | feature | draft | `features/` |
| SPEC-0032 | VIZ     | Pipeline Visualization & Live Tracker         | feature | draft | `features/` |
| SPEC-0033 | DESIGN  | Visual Design Language & Process              | architecture | draft | `architecture/` |
| SPEC-0034 | MACOS   | macOS Signing, Entitlements & File Access (TCC-protected vaults) | architecture | draft | `architecture/` |
| SPEC-0035 | HEALTH  | Knowledge Health & Structural Lint            | feature | draft | `features/` |
| SPEC-0036 | CONTRA  | Contradiction Lifecycle                       | feature | draft | `features/` |
| SPEC-0037 | WATCH   | Folder-Watch Ingestion (programmatic ingress) | feature | draft | `features/` |
| SPEC-0038 | QCAP    | Quick Capture (frictionless global capture; macOS first) | feature | draft | `features/` |
| SPEC-0039 | EXPLORE | Explore & Visualization (entity-neighborhood view) | feature | draft | `features/` |
| SPEC-0040 | RICHIN  | Rich Ingestion (formatted paste / multi-file drag / chat) | feature | draft | `features/` |
| SPEC-0041 | INTAKE  | Proactive Intake                              | feature | draft | `features/` |
| SPEC-0042 | EVAL    | Evals & Scenario Harness (seeded-KB cognition evaluation) | architecture | draft | `architecture/` |
| SPEC-0043 | SENSE   | Sensitivity Classification (labels, propagation, the gate comparator) | feature | draft | `features/` |
| SPEC-0046 | COMPOSE | Encyclopedic Entity Pages (Compose — human-readable top layer) | feature | draft | `features/` |
| SPEC-0045 | QUIESCE | Graceful Shutdown (Quiesce & Drain) | feature | draft | `features/` |
| SPEC-0047 | EVALSURF | Eval Surface (the quality instrument — per-stage/action cognition eval) | feature | draft | `features/` |
| SPEC-0048 | SCALE   | Control Panel — user-configurable scale & model | feature | draft | `features/` |
| SPEC-0049 | HEAL    | Self-healing deciders (converge or ask, never toss) | feature | draft | `features/` |
| SPEC-0050 | DIR     | Directives — the interpretation layer (durable disambiguation) | feature | draft | `features/` |
| SPEC-0051 | COHERE  | Graph Cohesion (communities, not islands or a hairball) | feature | draft | `features/` |
| SPEC-0052 | MEDIA   | Binary / Media Intake (PDF + image OCR via Copilot SDK multimodal) | feature | draft | `features/` |
| SPEC-0053 | AGENTSIA | Manage-section Information Architecture (Agents/Researchers/Jobs clarity, "WS-E") | feature | draft | `features/` |
| SPEC-0054 | RMEM    | Researcher Memory & KB-Grounding (fit-and-fill, don't repeat, resume) | feature | draft | `features/` |
| SPEC-0055 | RELEASE | Release Cadence & Signed Builds (tag-based, signed+notarized; macOS first) | feature | draft | `features/` |
| SPEC-0056 | UPDATE  | In-app Auto-Update (electron-updater via GitHub Releases; stable+beta) | feature | draft | `features/` |
| SPEC-0057 | BRAND   | Brand Identity (Vellum visual language, color/type/motion) | feature | draft | `features/` |
| SPEC-0058 | STATE   | UI State Model — Projection-Backed Reads (no live vault scans on the render path) | architecture | draft | `architecture/` |
| SPEC-0060 | VUX     | Vellum v3 UI — whole-app visual & IA direction (one language; top bar; rail; motion) | feature | active | `design/` |
| SPEC-0061 | REFIT   | Functional Rethink — v3 flows ↔ backend fit (responsiveness/git/index/interaction-model bets) | architecture | draft | `architecture/` |

## Reserved / planned (not yet written)

Feature specs, organized by the SPEC-0004 lifecycle stage they belong to. Numbers
assigned at creation time.

| Likely key | Candidate title                  | Type    | Stage     | Notes |
| ---------- | -------------------------------- | ------- | --------- | ----- |
| ~~QCAP~~   | _written → SPEC-0038 (key QCAP)_  | feature | Ingest    | hotkey + tray-sheet variant of CAPTURE (SPEC-0013) — calls SPEC-0008; macOS first |
| ~~RICHIN~~ | _written → SPEC-0040 (key RICHIN)_ | feature | Ingest  | richer text / drag files / chat (extends SPEC-0013; calls SPEC-0008) |
| ~~WATCH~~  | _written → SPEC-0037 (key WATCH)_ | feature | Ingest    | programmatic ingress — connector onto INGEST (SPEC-0008) |
| ~~INTAKE~~ | _written → SPEC-0041 (key INTAKE)_ | feature | Ingest  | Proactive Intake — scheduled pull of email/news/calendar as **primary** sources (vs RESEARCH's secondary corroboration); composes SPEC-0023 JOBS + SPEC-0008 INGEST |
| ~~CATALOG~~ | _written → SPEC-0015 (key DECOMP)_ | feature | Enrich  | Decompose (Enrich v1) — entity extraction |
| ~~CLAIMS~~ | _written → SPEC-0016 (key CLAIMS)_ | feature | Enrich  | Claims (Enrich v2) — internal substance about entities |
| ~~RESEARCH~~ | _written → SPEC-0028 (key RESEARCH)_ | feature | Enrich  | Researchers: parallel registry (Web/Code/M365 + custom), invoked inline/scheduled/on-demand |
| ~~CONNECT~~ | _written → SPEC-0020 (key CONNECT)_ | feature | Enrich  | Connect & Expand (Enrich v3) — sole writer of evergreen `entities/` + promotion gate (SPEC-0019 CANON-5) |
| ~~ASK~~    | _written → SPEC-0026 (key ASK)_  | feature | Query     | grounded NL query — agentic structure-aware retrieval |
| ~~EXPLORE~~ | _written → SPEC-0039 (key EXPLORE)_ | feature | Explore | in-app read-only entity-neighborhood view over `entities/`; global graph + timeline deferred (v2) |
| ~~REVIEW~~ | _written → SPEC-0018 (key REVIEW)_ | feature | Review  | the "needs you" queue (AUTO-10) — boolean escalations → primary sources |
| ~~REFLECT~~ | _written → SPEC-0024 (key REFLECT)_ | feature | Reflect | Reflect & Rumination — runs on the Autonomous Jobs engine (SPEC-0023, key JOBS) |
| ~~AUDIT~~  | _written → SPEC-0029 (key AUDIT)_ | feature | Audit     | canonical audit model + coverage mandate + read-only Activity/Lineage views |
| ~~REPLAY~~ | _written → SPEC-0022 (key REPLAY)_ | feature | Replay  | full rebuild v1; partial/selective replay (LIFE-12/13) still planned |
| ~~PANEL~~  | _written → SPEC-0027 (key PANEL)_ | feature | _x-cut_  | Manage section: Jobs/Agents/Sources/Settings views |
| ~~VAULT~~  | _written → SPEC-0031 (key VAULT)_ | feature | _x-cut_  | clean graph (entities only), readable entity pages, shipped .obsidian config |
| ~~RELEASE~~ | _written → SPEC-0055 (key RELEASE)_ | feature | _x-cut_ | tag-based on trunk; signed+notarized macOS first |
| ~~UPDATE~~  | _written → SPEC-0056 (key UPDATE)_  | feature | _x-cut_ | electron-updater via GitHub Releases; stable+beta |
| BRAND      | Release Polish (branding/icons/identity) | feature | _x-cut_ | reserves SPEC-0057; co-designing identity with Principal |

> Numbers are assigned at creation time, in order, to avoid gaps.
