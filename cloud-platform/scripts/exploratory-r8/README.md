# exploratory-r8 · U138 RPC frame timeline probe

Hardened, signable probe for U138: after an Orca Web refresh/reopen the host's
active tab can disagree with the rendered DOM and the client store. It drives
activate A -> activate B -> reload, page close -> reopen, and quick tab
open/close, recording every `session.tabs.*` frame plus the apply decision so a
red sample can be attributed.

Product code, `cloud-platform/apps/`, the ledger, and PROGRESS are not modified.

## Files

- `cloud-platform/scripts/exploratory-r8/u138-frame-timeline.mjs` — hardened main probe.
- `cloud-platform/scripts/exploratory-r8/u138-frame-timeline-race.mjs` — race-window
  stress variant (unchanged entry): reloads as soon as a renderer
  `session.tabs.activate` send frame is recorded. Knobs: `U138_RACE_DELAY_MS`,
  `U138_RACE_SETTLE_MS`.
- Output: each run writes the authoritative copy directly to
  `cloud-platform/evidence/exploratory-r8/run-<ts>/u138-timeline.json` and
  `summary.json` (gitignored). The shared
  `evidence/exploratory-r8/u138-timeline.json` is only a latest-run pointer.

## Entry

| Item               | Value                                                                     |
| ------------------ | ------------------------------------------------------------------------- |
| Platform / console | `https://127.0.0.1:18787/` (self-signed)                                  |
| Console route      | `#/projects` (`#projectBody` table)                                       |
| Login              | `zhangsan` / `Passw0rd!` (also accepts `U138_USERNAME` / `U138_PASSWORD`) |
| Project            | `zhangsan-demo` (override with `U138_PROJECT_KEY`)                        |
| Workspace entry    | row button `button[data-orca-web="<projectId>"]` → popup                  |

## Run

```bash
node cloud-platform/scripts/exploratory-r8/u138-frame-timeline.mjs
U138_CYCLES=3 U138_REOPEN_CYCLES=3 U138_QUICK_CYCLES=5 \
  node cloud-platform/scripts/exploratory-r8/u138-frame-timeline.mjs
```

Environment knobs: `U138_PLATFORM_URL`, `U138_USERNAME`, `U138_PASSWORD`,
`U138_PROJECT_KEY`, `U138_CYCLES`, `U138_REOPEN_CYCLES`, `U138_QUICK_CYCLES`,
`U138_SETTLE_MS` (default 5000, min 1000; the design recommends ≥5 s between the
two reads of a point, env lowers it for smoke only), `U138_RELOAD_STABLE_MS`
(default 2500, min 2000: settle floor before the first post-reload/post-reopen
read), `U138_HEADLESS=0`, `U138_PAGE_FRAME_LIMIT`, `U138_RUN_ID`,
`U138_HOST_STATE_ROOTS` (colon-separated host user-data roots, default
`~/orca-local-env/host` and `~/orca-local-env/host2`).

## Scenarios

1. **reload (C1) x `U138_CYCLES`**: sample `start` → click A → sample
   `activate-a` → click B → sample `activate-b` → `page.reload()` → wait for the
   shell, a `U138_RELOAD_STABLE_MS` settle floor, and a tab count that holds for
   1 s → sample `after-reload`.
2. **reopen (C3) x `U138_REOPEN_CYCLES`**: close the workspace page → click the
   console project entry again (same pairing context) → wait for the shell and
   the same stability gate → sample `after-reopen`. Cross-reopen active equality
   requires every reopen point to be valid and to expose exactly one DOM active.
3. **quick open/close (C2) x `U138_QUICK_CYCLES`**: create a temp tab → sample
   `opened` → close it through the **real tab-strip close button**
   (`[data-tab-close-button]`) → sample `closed`. No injected `session.tabs.close`
   remains on the signed path. A failed create or close makes the round INVALID
   (the failed close also invalidates the `opened` point); it is never a red.
   The round counts as closed **only** when the tab is really gone from the DOM
   after the UI close; an INVALID round is not evidence of a healthy quick path.

### Quick-close interaction fidelity

The gesture must be proven to reach the close button before its result is read:

- **Hit assertion.** The close button is scrolled into view and hovered, then
  `document.elementFromPoint(center)` must resolve to the button or one of its
  descendants. Otherwise the round fails with `close-button-obscured` and the
  evidence records `{cx, cy, w, h, topTag, topClass, topTabId}`.
- **Activation comparison.** `store.activeTabIdByWorktree` (active group) and the
  target tab's `data-active` are read before the click and polled after it. If
  the target tab was not active before, becomes active, and is still present,
  the round fails immediately with `ui-close-activated-instead` instead of
  waiting the 15 s close deadline. That means the pointer gesture was consumed
  by tab activation, not by the close handler.
- **Confirm dialog.** A running terminal close raises the product's Radix
  `CloseTerminalDialog` (`[data-slot="dialog-content"]`); the probe clicks its
  destructive confirm button (`button[data-variant="destructive"]`, labels
  `Stop and Close` / `Stop Agent` / localized equivalents) to complete the same
  close a user would. The clicked label is recorded. If a dialog appears but no
  reliable confirm button can be located, the round fails with
  `close-blocked-by-confirm-dialog` rather than guessing.
- **`pointer-synthetic` is not used.** The signed path is a real Playwright
  pointer click. A synthetic `el.click()` fallback would skip
  pointerdown/hover/pointerup, so it would not prove the pointer path; it is
  deliberately not implemented. Injecting `session.tabs.close` through the
  probe (`hostClose`) also remains cleanup-only and is never the quick close.
- `summarizeRun` keeps the dialog observation (`dialogOpen`, from
  `[data-slot="dialog-content"]`) so a confirmation that appeared during a
  sample is visible in the evidence, and `isolation` records the run-initial
  `skipCloseTerminalWithRunningProcessConfirm` setting.

Quick INVALID reasons (all prefixed `quick-close-failed:` except the create one):

| reason | meaning |
| --- | --- |
| `quick-create-failed: …` | no new sortable tab appeared, or the New tab / New Terminal click failed |
| `tab-not-found` | the created DOM id is not addressable by the tab selector (see id normalization below) |
| `close-button-not-found` | the tab has no `[data-tab-close-button="true"]` |
| `close-button-obscured` | `elementFromPoint(button center)` is not the button; coordinates and top element recorded |
| `ui-close-activated-instead` | the click activated the target tab and the tab is still present |
| `close-blocked-by-confirm-dialog` | a confirm dialog appeared and its destructive confirm could not be clicked |
| `ui-close-thrown: …` | the Playwright click or a post-click read threw |
| `tab-still-present-after-ui-close` | no activation change and the tab survived the 15 s close deadline |

`createTempTab` reads `[data-testid="sortable-tab"]` `data-tab-id` values and
normalizes a bare UUID to `web-terminal-<uuid>` (the form the tab selector and
the DOM use), so an early render cannot produce `tab-not-found` for an id the
probe never saw in the DOM.

Every sample point is **dual-read**: initial read → wait `U138_SETTLE_MS`
(default 5 s, ≥5 s recommended) → re-read. A point is `consistent` only when
both reads agree with each other and all views agree. The two reads disagreeing
makes the point `unstable`: counted in its own bucket, never a green, never a
red, and never given a causal attribution token.

## Three perspectives (host memory is not observed)

Each read records, with its own timestamp:

- **host persisted** active: `profile-state.db`
  `workspaceSession.activeTabIdByWorktree`, labelled
  `persistentSource: "profile-state.db:workspaceSession.activeTabIdByWorktree"`.
  If the file/key cannot be read the read is `hostPersistedOk=false` and the
  point is INVALID.
- **device projection**: `session.tabs.list` from the web client. This is a
  per-device projection and is asserted separately; it never substitutes for
  the host.
- **client**: DOM and store. DOM is scoped to `.app-layout` and visible nodes
  only; store active is the active group only (no `groups[0]` fallback).

There is **no host-memory read**. `hostMemory` is emitted as `"UNKNOWN"` with
`hostMemorySource: "unavailable"` and takes no part in `consistent`:
`memoryPersistent` no longer exists. A green therefore asserts host persisted +
device projection + client DOM/store agreement. It does **not** claim host
memory agreement; the memory-vs-persisted axis (H-B) is not judged here.

`activeTabIdByWorktree` is the focus/terminal id and is recorded as
corroborating evidence, not as the group's active tab.

## Apply telemetry (H-A)

`addInitScript` sets `localStorage['orca.debug.sessionTabs']='1'` before any
page script, so the T1 renderer tracer (`window.__orcaSessionTabsTrace`) is on
from the first frame. Each sample records:

- `lastFrame` — last trace frame before the DOM read;
- `lastAppliedFrame` — last frame carrying an apply decision;
- `lastAppliedTrueFrame` — last frame with `applied=true`, **diagnostic only**;
  the apply pipeline writes `true` at entry, so this is not evidence of a race
  or of a state change;
- `lastQualifyingAppliedFrame` — the only frame allowed to answer H-A.

Frames are filtered to the sampled worktree: `listAll` per snapshot (`worktree`)
and single-snapshot stream frames by `result.worktree`. The frame-level
`applied` on a `listAll` frame is an aggregate over every worktree and is kept
only as `frameAppliedAggregate`; H-A never reads it.

`lastQualifyingAppliedFrame` must satisfy all of:

1. `applied === true` for this worktree's snapshot, **and** its method is one of
   `session.tabs.list` / `session.tabs.listAll` / `session.tabs.subscribe` /
   `session.tabs.subscribeAll`. Response frames from `activate`,
   `createTerminal`, or any other write never qualify;
2. the same document contains a client selection write (`activate` / `close` /
   `closeLifecycle` / `createTerminal`) and the frame's `ts` is strictly later
   than the last one. With **no** selection write in the document there is no
   timing anchor, so H-A is `unknown` by construction;
3. it carried an `activeTabId` different from both the sampled DOM and the
   sampled store.

H-A is `affirmative` only for such a frame that lacks
`applyOptions.hostActiveAuthoritative === true`. If no frame qualifies the
verdict is `unknown`; the probe does not guess. A qualifying frame that did
adopt the host active is `negative`.

## Attribution tokens

The second read of an inconsistent point is classified in this order:

| token               | condition                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `none`              | green: both reads agree and host persisted + projection + client all agree                                              |
| `INVALID`           | point failed validity (see below)                                                                                       |
| `unstable`          | the two reads disagree; excluded from causal attribution                                                                |
| `client-ahead-host` | DOM=store ≠ host persisted, and the last client write's response active equals host persisted                           |
| `host-frame-not-won`| a qualifying applied frame carried host persisted active, yet the client kept a different active                        |
| `H-C`               | device projection ≠ host persisted                                                                                      |
| `H-A`               | a qualifying list/subscription applied frame lacked `hostActiveAuthoritative` (see above)                              |
| `H-B`               | a qualifying stream (`subscribe`/`subscribeAll`) applied over the last client write                                     |
| `H-D`               | `activate` responses landed out of send order                                                                           |
| `unknown`           | none of the above; no qualifying frame after the last client write, no selection write to anchor against, or direction not attributable |

`client-ahead-host` and `host-frame-not-won` can both hold at the same sample
point (the client leads the host while a host frame carrying the host active
was not adopted). The table order is the priority: **first match wins**, so
`client-ahead-host` is reported when both apply.

`diagnosis` is a factual direction string recorded for red points
(`client-ahead-host`, `host-did-not-follow-write`, `projection-lag`, ...). The
earlier `host-moved-after-write` label was wrong for this defect and is gone.

## INVALID

A sample point is INVALID and excluded from green/red when any of these holds:

- `hostPersistedOk=false` (host persisted state unreadable);
- `projectionOk=false` (`session.tabs.list` failed after its retries; projection
  is a required perspective, not an optional extra);
- `hasStore=false` or the active group is missing;
- topology precondition fails: `<2` tabs, `<2` groups, or the driven A/B tabs
  are not in different groups;
- baseline host state read failed (this invalidates every point in the run);
- the T1 trace is unavailable **or empty** (a handle with zero recorded frames
  cannot answer H-A);
- quick round: tab creation failed, or the real UI close failed / the tab was
  still present afterwards. A failed close also invalidates that round's
  `opened` point. The failure vocabulary is listed under
  [Quick-close interaction fidelity](#quick-close-interaction-fidelity); a round
  counts as closed only after the DOM no longer contains the tab, so an INVALID
  quick round carries no "quick is healthy" signal.

Invalid points are counted in a separate `invalid` bucket. `unstable` points are
counted in their own bucket too. Neither contributes to `green`, `red`, or
`reproduced`.

## Sign-off: `conclusive`

`conclusive` is `true` only when **all** of these hold:

1. no INVALID points;
2. no unstable points (an unstable point has no causal reading);
3. the script executed completely: the sample-point count equals
   `CYCLES × 4 + REOPEN_CYCLES + QUICK_CYCLES × 2` and the run was not blocked;
4. the baseline host persisted state and the baseline device projection were
   both readable, and every read in the run had a readable projection.

Otherwise `conclusive` is `false` with a `conclusiveReason` listing the
blockers. Only a `conclusive: true` run may be quoted as a signed
"reproduced" **or** "not reproduced" result.

`verdict.reproduced` is `null` when there is no stable valid sample — either no
valid sample at all (for example every point is INVALID) or every valid point
is unstable. It is `true` when at least one stable valid red exists, and
`false` only when at least one stable valid point exists and none of them is
red. A `reproduced: null` run is **not** evidence of non-reproduction.
`reproducedByScenario` applies the same rule per scenario so a quick-only red
is not reported as a reload/reopen regression.

Restore and cleanup run before the final verify: the probe activates the
baseline host value, closes the tabs it created, then reads the host state
again; if cleanup moved the active tab, it restores once more, waits ≥1 s for
the host's debounced persistence write to land, and re-verifies.
`isolation.restored` is `true` only when the baseline was readable, the restore
call succeeded, and the post-cleanup host persisted value matches the baseline.
A baseline read failure can never yield `restored: true`.

## Output

`run-<ts>/u138-timeline.json` plus `run-<ts>/summary.json`:

```jsonc
{
  "samples": [
    {
      "cycle": 1,
      "phase": "after-reload",
      "valid": true,
      "stable": true,
      "consistent": true,
      "first": {
        "domActive": ["web-terminal-…"],
        "storeActive": "…",
        "projectionActive": "…::…",
        "hostPersistentActive": "…",
        "hostMemoryActive": "UNKNOWN",
        "hostMemorySource": "unavailable"
      },
      "second": { "…": "same shape" },
      "hA": { "verdict": "unknown", "reason": "no applied frame after the last selection write …" },
      "attribution": { "token": "none", "reason": "all three perspectives agree in both reads" }
    }
  ],
  "verdict": {
    "green": 25,
    "red": 0,
    "unstable": 0,
    "invalid": 0,
    "expectedSamplePoints": 25,
    "scenarioComplete": true,
    "reproduced": false,
    "reproducedByScenario": { "reload": false, "reopen": false, "quick": false },
    "conclusive": true,
    "conclusiveReason": null,
    "conclusiveChecks": {
      "scenarioComplete": true,
      "noInvalid": true,
      "noUnstable": true,
      "baselineHostPersistedReadable": true,
      "baselineProjectionReadable": true
    },
    "perspective": "host-persisted + device-projection + client DOM/store (host memory UNKNOWN)",
    "hostMemory": "UNKNOWN",
    "hostMemorySource": "unavailable",
    "byScenario": {},
    "redSamples": [],
    "unstableSamples": [],
    "invalidSamples": []
  }
}
```

`matches` on each read now contains `domHostPersisted` / `storeHostPersisted`
instead of the removed memory fields. Terminal output prints one line per
sample point (`GREEN` / `RED` / `UNSTABLE` / `INVALID`) with both reads, host
persisted, the attribution token, and the last decision / H-A-candidate frames
for red points.

## Notes / limits

- **Sign-off condition**: quote this probe only for a run with
  `conclusive: true`. The verdict covers host persisted + per-device projection
  + client DOM/store; it does not cover host memory.
- Host memory is not observed. H-B (memory vs persisted inside the host) is not
  judged. Reading host memory needs a host debug RPC or a privileged probe, not
  a relabelled persisted file.
- The quick-close path is the real tab-strip close button; created/closed tabs
  and cleanup attempts are recorded under `isolation`.
- The host persisted source is read from the machine running the probe. The
  host side of this probe is valid only when the host and the probe share a
  machine (local rig); a remote host needs a host-side debug RPC.
- `tab::leaf` is collapsed to `tab` when comparing, so leaf/pane changes inside
  one tab are out of scope.
- The probe calls `session.tabs.list` at sample time; that method may restore
  structured tabs on the host, so probe frames are tagged `source:"probe"` and
  excluded from "last client write".
- `window.__store` is required; without it the sample is INVALID (no degraded
  oracle).
- The web bundle must include the T1 tracer (commit `f72ee67dbc8`). Rebuild
  `out/web` (`pnpm build:web`) if `__orcaSessionTabsTrace` is absent; the host
  serves the bundle from disk per request, so no restart is needed.
