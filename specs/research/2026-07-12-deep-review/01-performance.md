# 01 — Performance (engine · renderer · Ask)

Deep Review 2026-07-12. Static analysis at `origin/main` (`8e8ec5b`). Reference vault for all estimates: **1k entities / ~3k claims / ~1.5k sources**; "year vault" = 50 captures/day × 365 ≈ 18k sources / ~10k entities. Finding IDs (`PERF-E*` engine, `PERF-R*` renderer, `PERF-A*` Ask) are shared with `05-issue-index.md` and the GitHub issues.

**Shape of the problem in one line:** derived state is recomputed by re-walking the vault on timers (five independent loops + per-request walks), nothing is invalidated by the one event that defines freshness (the canonical HEAD move), and nothing pushes to the renderer — so the app burns compute while idle, serializes user writes behind maintenance, and still shows stale views.

---

## A. Engine — idle CPU, ingest cost, memory (PERF-E1..E12)

### PERF-E1 — Graph projection rebuild is O(N×M) file reads; coalescing makes it a permanent busy-loop — **P0**
`collectAllClaims` (`app/src/kb/graphProjection.ts:73,146-153`) calls `tools.claimsForEntity` once per entity; each call re-walks and re-parses **every** claim file (`app/src/kb/recallTools.ts:200-218` → `allClaims()` `:149-162`). One rebuild ≈ N×M claim reads + 2N entity reads + the N×(N+M) backlink scan + ≤S source reads ⇒ **~2-3M file reads/rebuild** at reference size. Cadence 5s (`app/src/main/pipeline.ts:771`); the store's coalescing (`app/src/main/projectionStore.ts:98-106`) means a >5s compute simply runs back-to-back forever. Even a 200-note vault (~120k reads ≈ 10-20s) exceeds the interval.
**Fix:** (1) one `allClaims()` walk grouped by subject (E×C→C, ~40 lines); (2) HEAD-gate the tick — the `refreshGraphProjection()` advance hook already exists (`pipeline.ts:823`); an unchanged HEAD is a no-op.
**AC:** one rebuild ≤ N+M+S reads (instrumented); idle vault performs zero rebuild reads over 10 minutes.

### PERF-E2 — The 2.5s status tick is uncached O(vault), bypassing the queue caches the stages already have — **P0**
`computePipelineStatus` (`pipeline.ts:569-587`, every 2.5s via `:675,700-708`) calls the raw queue readers (decompose O(S) source+audit walk, claims O(N·src), connect all-candidates), two set-aside full walks, `readConversionCounts` (five recursive walks incl. `sources/` on staging **and** main, `kb/conversionCounts.ts:39-50`), a whole-file read of `pipeline.log` up to 5MB (`kb/devlog.ts:273-280`), a spans re-parse during ingest (`kb/perfIndex.ts:123-159`), and one git spawn per worktree (`pipeline.ts:550`). The HEAD-keyed `CanonicalQueueCache` (`kb/queueCache.ts:34-72`) exists precisely for these walks — only the stage drains use it. At `devLogLevel: debug`, span-mirroring keeps the log at its 5MB ceiling ⇒ ~7GB/hour read amplification.
**Fix:** expose `stage.cachedQueue()` and serve status from the caches; HEAD-key conversion counts and set-asides; byte-budget tail-read the log (the spans reader already does this); read `.git/HEAD`/ref files directly instead of spawning.
**AC:** idle tick = O(1) fs ops, 0 git spawns; tick <10ms on a 10k-note fixture.

### PERF-E3 — Connect's 30s idle sweep does whole-vault work under the canonical-writer lock; the link queue never shrinks — **P0**
Every drain pass unconditionally runs `readLinkQueue` (all claims + all entities, `kb/connectStage.ts:1041-1048`), then `linkOne` **per queued node under `lock.run`** (`:1535-1554`) — each: ensure worktree (~4 spawns) + `reset --hard` + `clean -fd` (`:1069-1070`) + another full claims read (`:1081`) + full entity read (`:1092`) + all reviews (`:1111`), usually ending byte-stable no-op (`:1164-1166`) — then `linkOrphansOnce` (`:1289-1334`) and `dedupClaimsOnce` (`:1220-1228`), also under the lock. `relatesTo` hints are claim data, never consumed, so the queue grows monotonically (L≈300 at reference). Idle recurrence: ~(2L+12) spawns + ~(2L+4) full-vault read passes per 30s, mostly holding the FIFO mutex (`kb/stageLock.ts:46`, no priority classes) — **capture (`kb/orchestrator.ts:264-268`), review answers, and settings saves queue behind it**. This is the mechanism of "hangs during ingest."
**Fix:** HEAD-gate all three passes; compute `linkOne`'s byte-stable check off-lock against a shared snapshot, lock only to commit; persist a per-node linked signature (claim-set hash) so the queue = actual pending work; add a capture-priority lane to the Mutex (mirror `copilotConcurrency`'s priority waiters).
**AC:** idle 10 min → 0 sweep spawns/reads after the first pass; capture p95 under an active sweep <250ms.

### PERF-E4 — Promote rewrites the entire evergreen tree per promotion — **P1**
Per evergreen path: `git rm -r -f` then `checkout staging -- <p>` (`kb/staging.ts:90-102`) — every tracked file under sources/entities/claims/outputs/directives is unlinked and rewritten even for a one-file change, on the live root Obsidian watches, every ≤3min under drain. Year scale ≈ 80k+ file ops per promote, multi-second lock holds, SSD write amplification, external-watcher rescan storms.
**Fix:** `git diff --name-status staging <mainHEAD>` and apply only the delta. **AC:** one-file promote touches ≤ a handful of files (mtime survey) in <300ms.

### PERF-E5 — Per-item ephemeral worktrees: ~12 git spawns + a full-tree checkout, ×2-5 lifecycles per pipeline hop — **P1**
`withEphemeralWorktree` (`kb/canonicalAdvance.ts:77-106`): `worktree add --force -B` checks out the **entire tree** per item-attempt; claims runs per (entity×source), compose per entity. One captured item (E=5) ≈ **~200 git spawns, ~17 full-tree checkouts, ~16 LLM subprocesses**; checkout cost grows with vault size (1-5s each at 30k files) — ingest gets slower every month, and this is the serialized fraction behind cap-1→cap-3 = 1.72×.
**Fix:** `worktree add --no-checkout` + `sparse-checkout set` of stage-touched paths (O(item) I/O), or pooled per-stage worktrees reset to checkpoint; long-term, object-DB commits (`hash-object`/`mktree`/`commit-tree`).
**AC:** archiving one item on a 10k-file fixture materializes ≤50 files, ≤6 spawns; per-item wall time flat ±10% between 100-file and 10k-file vaults.

### PERF-E6 — Activity index: full O(S) re-read of every audit file per HEAD move; git spawn per freshness poke — **P1**
`loadActivityIndex` freshness spawns git (raw `simpleGit`, unbounded — `kb/activityIndex.ts:189-195`); any HEAD move triggers a full re-read of every `audit.jsonl`/blocks/journal (`:101-133,145-179`). Ingest advances HEAD ~8-15× per item ⇒ ~8-15 full audit re-reads per capture (~150-270k file reads/item at year scale). Today polls it every 8s (`pipeline.ts:877-881`).
**Fix:** incremental index (per-file byte offsets, append-read grown files — audit files are append-only by design); freshness off the ref file mtime. **AC:** one advance re-reads only changed audit files; idle Today ticks spawn no git.

### PERF-E7 — Synchronous multi-MB JSON on the main thread; interval snapshot writes — **P1**
Graph projection persisted every refresh with full `entityMd`/`sourceMd` bodies (`pipeline.ts:788-793`); `JSON.stringify` of a 5-100MB object is a synchronous main-thread block (50ms-1s+) during which **every IPC handler stalls** — the renderer perceives an app hang. Activation loads the same blob with sync `readFileSync`+parse (`:780-786`), blocking first paint. Status snapshot written every 2.5s (~1GB/day at 30KB).
**Fix:** persist on content-hash change only; strip bodies from the persisted graph; move stringify/write off-thread; async activation load. **AC:** unchanged vault → zero cache writes over 10 min; main-thread longest task <50ms during refresh.

### PERF-E8 — Long-session RSS ratchet: O(vault) resident bodies + multi-MB/tick allocation churn — **P1** *(the "restart fixes it" mechanism)*
The graph store retains every entity body + every cited source body + claims + backlinks in memory (`graphProjection.ts:26-40`; `pipeline.ts:804-812`); each refresh allocates a complete second copy plus its JSON string while the old one is referenced; each status tick allocates 2-7MB transient. V8 old-space grows to fit peaks and rarely returns pages — RSS ratchets over hours **without a classic leak**. The OBS-21 leak detector requires strictly-monotonic RSS (`kb/memorySampler.ts:115-123`), which sawtooth churn defeats — the watchdog is quiet through exactly this failure mode. Verified bounded (not leaking): sampler ring, log/span rotation, semaphore waiters, mutex chain, watch maps, conversation store.
**Fix:** E1+E2 remove most churn; drop bodies from the in-memory projection (read on demand); relax the leak verdict to slope-over-window. **AC:** 8-hour idle soak at the 1k fixture: RSS delta <50MB; no multi-MB `entityMd` strings in a heap snapshot.

### PERF-E9 — Unbounded IPC payloads; remaining render-path live walks — **P2**
`kb:activityEvents`/`kb:activityLineage` return the full unbounded event array (every audit file read per call, `ipc.ts:683-693`) structured-cloned across the process boundary; `kb:healthReport` still runs the live 2N walk per invocation (`ipc.ts:595-611` — the projection swap is "held" per its own comment) duplicating Today's 8s walk. **Fix:** paginate events from the index; point healthReport at `makeProjectionTools(graphStore.current().data)`. **AC:** Activity drill-down ≤1MB, O(window) reads; healthReport does 0 fs reads warm.

### PERF-E10 — Compose sweep lacks the queue memo its sibling stages have — **P2**
`readComposeQueue` called raw every 30s (`kb/composeStage.ts:462-504`, 2N+ reads); claims/connect/decompose all import `CanonicalQueueCache`, compose doesn't. Mechanical ~10-line fix; mirror the existing cache tests.

### PERF-E11 — Idle git-spawn floor: ~2,500 spawns/hour doing nothing — **P2**
`listWorktrees` rev-parse per worktree per 2.5s, activity HEAD pokes, queue-cache pokes, plus the orchestrator taking the lock twice per 30s even with an empty inbox (`kb/orchestrator.ts:310-314,349`). **Fix:** read `.git/HEAD`/refs as plain files; readdir the inbox outside the lock; skip unchanged status writes. **AC:** idle app spawns 0 git processes over 5 minutes.

### PERF-E12 — Abandoned quick-capture screenshots leak temp PNGs — **P2**
Handles evicted only on consume (`main/quickCaptureScreenshot.ts:20,93,107-108`); close-without-submit leaks the Set entry and a multi-MB PNG. **Fix:** evict+rm on sheet close; sweep >1h files at startup.

### Idle budget (1k-note vault, user doing nothing)
| Loop | Cadence | One tick | Cost |
|---|---|---|---|
| graph store (E1) | 5s coalesced | ~N×M+2N reads + full JSON write | runs continuously: ~1 core + disk, forever |
| status tick (E2) | 2.5s | O(S)+O(N·src) walks ×3, 5 dir walks, ≤5MB log, 1-2 spawns, snapshot write | ~0.3-1s/tick ≈ 15-40% core |
| connect sweep (E3) | 30s | (2L+12) spawns + (2L+4) full-vault passes, mostly under lock | minutes/sweep at L=300; lock ~always held |
| Today store | 8s | 2N health reads + 1 spawn + feed | 0.2-0.5s/tick |
| compose sweep (E10) | 30s | 2N+ reads | ~0.2s |
| misc sweeps/pokes (E11) | 30-60s | spawns + lock + writes | ~1-2.5% core |

**Total: ~1.5-2 cores continuous + ~2,500 git spawns/hour at 1k notes; loops physically never complete an interval at year scale.**

### Ingest budget (one text item, E=5, cap=1)
~200+ git spawns · ~16 LLM sessions · ~17 full-tree checkouts · ~10 full audit re-reads (O(S) each) · one whole-tree promote — non-LLM overhead alone ~10-60s at 1k notes, minutes at 10k, all serialized through one mutex.

---

## B. Renderer — everyday UI + long-session bloat (PERF-R1..R15)

### Poll/timer census
| Owner | Cadence | Cleared? | Paused when view hidden? | Paused when window hidden? |
|---|---|---|---|---|
| Shell review badge (`shell.ts:242`) | 5s | only if `#app` detached (never) | n/a | yes |
| Reviews view (`reviewsView.ts:88`) | 5s | on re-mount | **yes** (correct model) | yes |
| Agents (`agentsView.ts:21`) | 5s | never | **no — guard checks the wrong element** (R2) | yes |
| Capture (`captureView.ts:292`) | **1.5s** | **never** | **no** | **no** |
| Settings quiesce (`settingsView.ts:716`) | 1s | self-stops | no (drain-bounded) | no |
| Today clock (`todayView.ts:247-249`) | 30s | never | no | no |

Steady state after visiting Today→Capture→Agents ≈ **3,100 IPC round-trips/hour**, 2,400/hr of which (Capture) continue even minimized, forever.

- **PERF-R1 — Capture's 1.5s poll runs forever, everywhere, with error amplification — P0.** No visibility gating, no clear path, and `refreshStatus` has no try/catch: a rejecting handler ⇒ an unhandledrejection + `reportRendererError` IPC + a log line **every 1.5s until relaunch** (`captureView.ts:165-174,292`; `renderer.ts:161-168`). Rewrites innerHTML every tick even unchanged.
- **PERF-R2 — Agents' visibility guard checks the wrong element — P1.** Shell toggles `.hidden` on the outer `.view` (`shell.ts:162`); the poll guard checks the inner section that never gets the class (`agentsView.ts:28` vs `agentsHubView.ts:32,51-65`) — the designed pause never engages. Latent trap for any sub-mounted poller.
- **PERF-R3 — Activity: full ~10k-node innerHTML rebuild + refetch per interaction; focus and scroll destroyed — P1** (`activityView.ts:126-130,179-182,219-231`).
- **PERF-R4 — Ask transcript O(n²): every event re-runs marked+DOMPurify over all prior turns — P1** (`askView.ts:277,292,595-604`; `renderMarkdown` per turn per render).
- **PERF-R5 — First paint: white unstyled flash (no `show:false`/`backgroundColor`), monolithic single bundle (all views + marked + DOMPurify + dead CSS in every window), two sequential IPC round-trips before content — P1** (`main.ts:26-32`; `vite.renderer.config.ts` empty; `renderer.ts:181`; `todayView.ts:45-57`).
- **PERF-R6 — Settings first-open: 3-stage sequential waterfall incl. three subprocess spawns (git ×2 + Copilot probe) behind bare "Loading…"; Agents likewise 2×8s sequential probes — P1** (`settingsView.ts:77,85,102`; `agentsView.ts:37,46`).
- **PERF-R7 — qcap summon destroys and re-creates the window, reloading the entire app bundle per hotkey, serialized behind an up-to-1.3s selection read — P1** (`quickCaptureElectron.ts:36-57,209-237`).
- **PERF-R8 — Capture stages full file bytes in renderer memory, unbounded, module-level, indefinitely — P2** (`captureView.ts:21,79,97`; >25MB soft-warns only).
- **PERF-R9 — Latent whole-shell leak on re-mount: the badge poller is the one thing `mountShell` doesn't clean up — P2** (`shell.ts:242-251`; closure pins the entire detached shell; bites when vault-switch lands).
- **PERF-R10 — Explore repaints the whole surface (incl. an uncapped all-entities datalist) on every filter toggle; typed search wiped — P2** (`exploreView.ts:112-134,409-420`).
- **PERF-R11 — Every Health dismiss/remediate re-runs the live full-vault scan and repaints the list — P2** (`healthView.ts:220,238` → `ipc.ts:595-610`; use the Reviews optimistic-removal idiom + one debounced rescan).
- **PERF-R12 — No lifecycle contract; zero push: 8/10 surfaces freeze at first-visit data forever; 3 live surfaces = 3 hand-rolled idioms of varying correctness — P2 (architectural root).** Fix = `{mount, show?, hide?, unmount?}` registration + one `kb:projection-changed` broadcast + a shared `createVisibilityPoll` backstop (see Spine 2).
- **PERF-R13 — Perpetual ambient animations (box-shadow keyframes, forever-drifting watermark, permanently `.is-working` diamond) keep the compositor awake for the app's lifetime — P2** (`shell.ts:40-45`; `design-system.css:346-358`; `index.css:382`).
- **PERF-R14 — Dead/misrouted CSS in every window (theLine 558 lines, showcase, qcap-in-main and vice versa); zero `contain`/`content-visibility` anywhere — P2** (`renderer.ts:16-23`).
- **PERF-R15 — Reviews double-poll (badge + view) with no idle backoff — P3** (subsumed by R12).

**Renderer verdict:** plain-DOM template strings are not the bottleneck; the missing lifecycle + change-propagation layer is. Keep the stack; add ~3 small contracts (~500-800 LOC): view lifecycle, one push channel + renderer memo store, a keyed list-patch helper for Activity/Ask/Reviews. A framework rewrite would churn 8.5k prod + 8k test LOC and leave pull-IPC untouched.

---

## C. Ask/recall — latency (PERF-A1..A9)

### Latency budget — one Considered question, warm, 1k entities (~40-65s total)
| Stage | Warm cost | Share |
|---|---|---|
| IPC + config + budget preamble (full `entities/` walk, `recall.ts:260`) | ~60-160ms | <1% |
| Copilot slot (idle) | 0 | — |
| **SDK client + CLI server spawn + session create** (fresh per question) | **1.5-3s** | ~4% |
| **LLM round-trips** (~10-14 Opus turns @3-6s) | **35-48s** | **~65-75%** |
| **Tool executions** (~12 calls, O(vault) walks each) | **6-12s** | **~15-20%** |
| Citation verify + render + persist | <100ms | <1% |

- **PERF-A1** = engine E1 (the projection busy-loop competes with Ask for disk/CPU).
- **PERF-A2 — Every tool call re-walks the vault; zero reuse within one question — P0.** `makeReadOnlyTools` closes over `root` only; entityLookup/claimsForEntity/linkTraversal/grep are each full walks per call (`recallTools.ts:124-162,185-306`); a Considered run ⇒ tens of thousands of reads, ~100k+ syscalls. **Cheapest interim win in the app:** a ~40-line per-question lazy memo (entities/claims/backlink map/grep text cache built once per question) kills ~80-90% of tool time with no API change. AC: ≤1 walk per directory per question.
- **PERF-A3 — Fresh SDK client + `copilot` CLI server spawned per question and never stopped — P1 (process leak).** `recall.ts:257` builds a new client per ask; only `session.disconnect()` is called (`:294`); `RecallClient.disconnect` — the sole `client.stop()` — has no production caller. Every question pays a ~1.5-3s cold boot **and orphans one CLI server process for the app's lifetime**. Fix: process-wide singleton client + `stop()` on quit; then per-conversation session reuse.
- **PERF-A4 — No streaming, no tool progress: perceived latency = full wall-clock behind a static shimmer — P1 (cheapest big UX win).** The budget wrapper already sees every tool call (`recall.ts:388-398`) — emit `kb:askProgress` and swap the skeleton line ("Looking up *Mexico trip*… — retrieval 7 of 24"). SDK `tool.execution_start`/`assistant.message_delta` events exist unused.
- **PERF-A5 — Considered-by-default on the slowest model; Quick changes neither model nor reasoningEffort — P1.** No `recall` entry in `STAGE_MODEL_PREFERENCES` (`copilotModelProbe.ts:48-52`) ⇒ global Opus-first pick for every ask (`ipc.ts:468`); SDK `reasoningEffort` never set. Fix: recall-quick preference list (sonnet/haiku-first) + `reasoningEffort:'low'` when quick; revisit the default (Quick + inline "go deeper" escalation). Honest tier, recorded in the trace — consistent with the VUX-11 ruling.
- **PERF-A6 — Unbounded prompt growth: full history re-sent verbatim every turn; tool results never truncated — P2→P1 with use.** History concatenated raw (`recall.ts:362-365`); `readSource` returns whole files into context (`recallTools.ts:266-278`); 3.7KB skill + 7 schemas re-sent per question because sessions aren't reused. Fix: last-K-turns window + 16KB head/tail tool-result cap with honest truncation note. (ARG_MAX is a background-lane risk only — one-shot deciders still pass whole sources as argv: `claimsAgent.ts:68` et al.)
- **PERF-A7 — Wrong-entity resolution: first-substring-match in fs-walk order burns budget and quality — P2** (`recallTools.ts:176-181`). Rank by confidence; surface alternatives on ambiguity.
- **PERF-A8 — Saturated semaphore: interactive lane can't reclaim held slots; researchers hold one slot up to 60min; Ask 30s-times-out — P2.** Reserve one slot for interactive (background caps at ceiling−1, ~10 lines in `canGrantBackground`, mirroring the SCALE-3 reservation).
- **PERF-A9 — Per-question `countEntityNodes` full walk (Considered only) — P3.** Reuse the warm projection count.

**Post-index reality check:** SQLite/FTS5 turns each tool call into ~1-10ms, but LLM round-trips (~65-75%) remain — post-index Ask is still ~35-50s unless **N shrinks**. With the index, add one composite `search(query) → {entities, top claims, backlinks, snippets}` tool so a focused question needs 2-4 calls, not 10-24 — that converts index speed into answer speed by deleting whole LLM turns. Progress push (A4) is the only lever that improves today's 60s and post-index 35s alike; ship it independently.

---

## D. What fixes what (pain → findings)

| Reported pain | Root causes |
|---|---|
| High CPU / fans while idle | E1 (+A1), E2, E3, E10, E11, R13 |
| Ingest slow / hangs | E3 (lock contention), E4, E5, E6, BUG-1/5 (see 03) |
| Everyday UI slow / janky | R1, R2, R3, R4, R5, R6, R11, E7 (main-thread stalls), E9 |
| Ask too slow | A2, A3, A4, A5, A6, A8 (+E1 contention) |
| Long-session bloat / restart fixes it | E8, A3 (process leak), R1, R8, R9, R13, E12 |
