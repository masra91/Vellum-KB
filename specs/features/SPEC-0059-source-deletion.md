---
spec: SPEC-0059
key: SRCDEL
title: Source Deletion — Principal-initiated, git-committed removal
type: feature
status: draft
owners: [KB-Lead, Principal]
created: 2026-06-28
updated: 2026-06-28
related: [SPEC-0007, SPEC-0027, SPEC-0013, SPEC-0008, SPEC-0017, SPEC-0058, SPEC-0029, SPEC-0037]
supersedes: null
---

# Source Deletion — Principal-initiated, git-committed removal

> Let the Principal remove a source from the KB **inside the app**, durably (committed to
> git), so an unwanted source — e.g. an accidental double-submit — actually goes away
> instead of muddying state.

## 1. Intent (the why / JTBD)

The Principal occasionally lands a source they don't want — most concretely, the **same file
submitted twice** (see SPEC-0013 CAPTURE: direct capture computes a `contentHash` but never
looks it up, so identical content captured twice yields **two** sources). They want to get rid
of it.

Today there is **no in-app way to delete a source.** The only removal path is deleting the
`source.md` file in Obsidian — and **Obsidian does not commit to git.** The KB's source of
truth is the git-backed vault (SPEC-0007/0019), and the read surfaces increasingly read
committed projections (SPEC-0058). So an Obsidian-side delete leaves the file gone on disk but
**still present in committed state and in every projection** — the source isn't really gone, and
the divergence between disk and git "muddies state."

The job: *"I shouldn't have this source — remove it, for real, without leaving Obsidian, and
without me having to care about everything downstream that referenced it."* The payoff is a clean,
trustworthy vault the Principal manages from within the app.

**Reconciling with SPEC-0007 (sources are immutable, append-only ground truth — DATA-1/2/9):**
that invariant governs the **automated pipeline** — no stage may silently mutate or drop a source.
It does **not** bind the Principal, who owns their vault. Source deletion is a **deliberate,
explicit, audited, Principal-initiated lifecycle action** — the same stance SPEC-0027 PANEL-11
already takes for managed entities ("delete is required, not optional"), extended to sources
themselves. The append-only guarantee stays the default; a sanctioned manual delete is the
documented exception.

**Strategic backdrop (context, not scope):** this is one of several steps toward the Principal
managing the vault's lifecycle **natively in the app rather than through Obsidian** — see
`[[project-obsidian-drift-direction]]`. Obsidian-independence is a much larger lift and is **not**
in this spec; SRCDEL just stops one place where Obsidian is load-bearing.

## 2. Scope

**In scope:**
- An in-app action to **delete a single source by id**, removing its
  `sources/YYYY/MM/DD/<id>/` directory (source.md + raw payload/clip sidecars) from the
  canonical vault.
- The delete is **committed to git through the canonical-writer lock** and **audited** — never a
  disk-only change.
- A **place to see the sources present and pick one to delete** (a sources listing reachable from
  the Manage/Sources surface and/or from where a dupe is noticed — Explore/Activity).
- **Dedup-ledger reconciliation** so a deleted source's content isn't permanently blocked from
  re-ingestion (watch per-folder ledger, intake `seen.json`).
- **Capture-path dedup** (the trigger): direct capture should recognise identical content instead
  of silently creating a duplicate.
- **Reconciling out-of-band (Obsidian/filesystem) source deletions** into committed state, so a
  file removed outside the app stops muddying state.

**Out of scope (for now):**
- **Cascading delete / unlink** of derived entities, claims, outputs, or links that referenced the
  deleted source. The Principal explicitly accepts dangling references for v1 ("even if it doesn't
  undo or unlink things, idc"). A garbage-collection slice is a future follow-up.
- **Undo / restore** of a deleted source (git history still holds it; no in-app restore in v1).
- **Bulk delete** and **duplicate-detection/merge tooling** (find-and-merge existing dupes).
- **Full Obsidian-independence** — the broader direction this nudges toward, specced elsewhere.

## 3. User flows / feature surface

**Primary flow — delete a duplicate source:**
1. The Principal notices a source they don't want (e.g. two identical entries after a
   double-submit), surfaced in the Sources/Manage listing (or spotted in Explore/Activity).
2. They invoke **Delete** on that source.
3. A **destructive confirmation** (danger-styled, consistent with the existing intake/watch
   "Remove" dialogs) names the source and warns that links from derived items may be left dangling.
4. On confirm, the app removes the source's directory, **commits the removal** through the
   canonical-writer lock, and **audits** it.
5. The source disappears from the listing and from every projection — the removal is durable; it
   survives restart and is reflected in git history.

**Secondary / edge flows:**
- **Re-ingest after delete:** later, the same content can be captured/watched/intook again and
  produces a fresh source (the dedup ledgers were reconciled on delete — SRCDEL-6).
- **Out-of-band delete:** the Principal deletes a `source.md` directly in Obsidian; the app
  **detects the missing source and reconciles it into committed state** rather than erroring or
  showing stale data (SRCDEL-9).
- **Capture dedup:** the Principal captures the same file/text twice; the app recognises the
  identical `contentHash` and **does not silently create a second source** (SRCDEL-8).

## 4. Requirements

| ID        | Priority | Statement (short)                                            | Verify   |
| --------- | -------- | ------------------------------------------------------------ | -------- |
| SRCDEL-1  | must     | In-app action deletes a single source by id                  | none-yet |
| SRCDEL-2  | must     | Deletion is committed to git via the canonical-writer lock   | none-yet |
| SRCDEL-3  | must     | Deletion is audited (removed-source event survives)          | none-yet |
| SRCDEL-4  | must     | Deletion requires explicit destructive confirmation          | none-yet |
| SRCDEL-5  | should   | A surface lists present sources for selection/deletion       | none-yet |
| SRCDEL-6  | should   | Dedup ledgers reconciled on delete (re-ingest unblocked)     | none-yet |
| SRCDEL-7  | must     | No cascade required; dangling refs tolerated, never crash    | none-yet |
| SRCDEL-8  | should   | Direct capture dedups identical content (the double-submit)  | none-yet |
| SRCDEL-9  | should   | Out-of-band (Obsidian) source deletes reconciled to git      | none-yet |

### SRCDEL-1 — Delete a source
- **Status:** draft · **Priority:** must
- **Statement:** The app **MUST** provide an in-app action that deletes a single source by its id,
  removing its `sources/YYYY/MM/DD/<id>/` directory (source.md and raw/clip sidecars) from the
  canonical vault.
- **Rationale:** there is no in-app source delete today; Obsidian is the only path and it doesn't
  commit. This is the core capability.
- **Verify:** none-yet  ·  *(later: `test:` IPC handler removes the source dir for a given id)*

### SRCDEL-2 — Deletion is git-committed through the canonical writer
- **Status:** draft · **Priority:** must
- **Statement:** The deletion **MUST** be performed under the canonical-writer lock and committed to
  git (the SPEC-0027 PANEL-11 pattern: `active.lock.run` → remove path → commit → advance), so the
  removal is durable and reflected in committed state and projections — **never** a disk-only change.
- **Rationale:** the root cause of the muddied state is uncommitted (Obsidian) deletes. A real delete
  must land in git like every other canonical mutation (SPEC-0019/0014).
- **Verify:** none-yet  ·  *(later: `test:` after delete, the path is gone from the committed tree
  at a settled HEAD, and a re-read projection no longer contains the source)*

### SRCDEL-3 — Deletion is audited
- **Status:** draft · **Priority:** must
- **Statement:** Deletion **MUST** append an audit event recording the removed source id and the
  reason/actor; the audit trail **MUST** survive the source's removal.
- **Rationale:** mirrors PANEL-11 ground-truth retention — the *record that it happened* outlives the
  thing deleted, so the vault's history stays honest.
- **Verify:** none-yet  ·  *(later: `test:` a `source-deleted` audit event is present post-delete)*

### SRCDEL-4 — Explicit destructive confirmation
- **Status:** draft · **Priority:** must
- **Statement:** The delete action **MUST** require an explicit destructive confirmation (danger-styled),
  consistent with the existing intake/watch "Remove" dialogs, before removing anything.
- **Rationale:** delete is irreversible in-app (no v1 restore); it must never fire on a stray click.
- **Verify:** none-yet  ·  *(later: `test:` no removal occurs without confirmation)*

### SRCDEL-5 — A surface to see and pick sources
- **Status:** draft · **Priority:** should
- **Statement:** The app **SHOULD** present the sources currently in the KB in a surface from which a
  source can be selected and deleted (e.g. a sources listing in the Manage/Sources view, and/or a
  per-source delete reachable from Explore/Activity). This listing **SHOULD** read a maintained
  projection, not a live vault scan (SPEC-0058).
- **Rationale:** today the Sources view manages *sources of ingestion* (feeds/folders), not the
  sources themselves; the Principal has no in-app list of sources to act on.
- **Verify:** none-yet  ·  *(later: `test:`/`manual:` the listing renders sources and exposes delete)*

### SRCDEL-6 — Reconcile dedup ledgers on delete
- **Status:** draft · **Priority:** should
- **Statement:** On deletion, the dedup ledgers that reference the deleted source (the watch
  per-folder ledger and the intake `seen.json`) **SHOULD** be reconciled so that identical content can
  be re-ingested later rather than being permanently suppressed.
- **Rationale:** watch/intake dedup by content/external-id; a stale ledger entry would silently block
  ever bringing the content back after an intentional delete.
- **Verify:** none-yet  ·  *(later: `test:` after deleting a watched/intook source, re-running the
  source produces a fresh source)*

### SRCDEL-7 — No cascade required; tolerate dangling references
- **Status:** draft · **Priority:** must
- **Statement:** v1 **MUST NOT** be required to cascade-delete or unlink derived entities, claims,
  outputs, or links that referenced the deleted source. Such references **MAY** be left dangling, the
  system **MUST NOT** crash on a dangling reference, and Health (SPEC-0035) **MAY** surface it honestly.
- **Rationale:** the Principal explicitly scoped cascade out ("idc"). Render-safety for dangling refs
  is already an established bar (ENG-15/16); this requirement just makes the non-cascade contract
  explicit and forbids the regression.
- **Verify:** none-yet  ·  *(later: `test:` a view referencing a now-deleted source renders without
  crashing)*

### SRCDEL-8 — Capture dedups identical content
- **Status:** draft · **Priority:** should
- **Statement:** Direct capture (paste / drag-drop / file submit) **SHOULD** recognise content whose
  `contentHash` matches an existing source and avoid silently creating a duplicate — matching the
  dedup watch and intake already perform. The exact behaviour (silently skip vs. warn-and-allow-override)
  is an open question below.
- **Rationale:** this is the trigger for the whole spec; the hash is already computed at capture
  (`captureToInbox`), it's simply never looked up. Fixing it stops duplicates at the source.
- **Verify:** none-yet  ·  *(later: `test:` capturing identical content twice yields one source, or a
  clear already-captured outcome)*

### SRCDEL-9 — Reconcile out-of-band deletions
- **Status:** draft · **Priority:** should
- **Statement:** When a source's files are removed outside the app (e.g. deleted in Obsidian), the app
  **SHOULD** detect the absence and reconcile it into committed state (commit the removal) rather than
  treating the missing source as an error or continuing to show it as present.
- **Rationale:** directly addresses the "Obsidian doesn't commit → muddied state" half of the problem;
  without it, the in-app delete is the only clean path and external edits keep diverging. Overlaps the
  SPEC-0058 reliability model and SPEC-0037 watch reconciliation — see open questions.
- **Verify:** none-yet  ·  *(later: `test:` a source dir removed on disk is reconciled out of committed
  state on next scan/commit)*

## 5. Open questions

- [ ] **Where does the delete affordance live?** Extend the Manage/Sources view with a real sources
  listing, or hang a per-source delete off Explore/Activity (where a dupe is usually noticed), or both?
  (Lean: primary listing in Manage; secondary action from Explore. DLs to design the surface.)
- [ ] **SRCDEL-8 behaviour — soft or hard?** Capture is a deliberate act; a user might *intend* to
  re-capture. Silently dedupe (hard) vs. warn "already captured — add anyway?" (soft). Lean soft/warn
  to avoid surprising a deliberate re-capture.
- [ ] **SRCDEL-9 ownership.** Does out-of-band reconciliation belong in this spec, or fold into the
  SPEC-0058 projection/refresh seam (and/or SPEC-0037 watch reconciliation)? It may be cleaner there.
- [ ] **Cascade follow-up.** Do we eventually want a slice that garbage-collects or relinks entities
  orphaned by a source delete? Deferred for now per the Principal, but worth a tracked future spec.
- [ ] **Raw payload + clip sidecars** — confirm delete removes the whole `<id>/` directory (source.md,
  `raw:` original, `clip` HTML), i.e. nothing of the source is left on disk. (Assumed yes.)

## 6. Changelog

- 2026-06-28 — created (draft). Scoped from a Principal request after an accidental double-submit:
  in-app, git-committed source delete; cascade explicitly out; capture-dedup + out-of-band
  reconciliation included as related fixes. Queued behind the SPEC-0058 reliability + Vellum UX v2
  work; not for dispatch yet.
