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
`U138_SETTLE_MS` (min 2000), `U138_HEADLESS=0`, `U138_PAGE_FRAME_LIMIT`,
`U138_RUN_ID`, `U138_HOST_STATE_ROOTS` (colon-separated host user-data roots,
default `~/orca-local-env/host` and `~/orca-local-env/host2`).

## Scenarios

1. **reload (C1) x `U138_CYCLES`**: sample `start` → click A → sample
   `activate-a` → click B → sample `activate-b` → `page.reload()` → sample
   `after-reload`.
2. **reopen (C3) x `U138_REOPEN_CYCLES`**: close the workspace page → click the
   console project entry again (same pairing context) → wait for the shell →
   sample `after-reopen`. Cross-reopen active equality is recorded.
3. **quick open/close (C2) x `U138_QUICK_CYCLES`**: create a temp tab → sample
   `opened` → close it → sample `closed`. The close is injected through
   `session.tabs.close` (not a UI click); treat quick reds as a synthetic-path
   finding until the UI-close variant lands.

Every sample point is **dual-read**: initial read → wait `U138_SETTLE_MS`
(≥2 s) → re-read. A point is `consistent` only when both reads agree with each
other and all views agree; disagreement between reads is red with
`attribution.token: "unstable"`, never a green and never a causal token.

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

1. `applied === true` for this worktree's snapshot;
2. its `ts` is strictly later than the last client selection write
   (`activate` / `close` / `closeLifecycle` / `createTerminal`) recorded in the
   same document;
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
| `H-A`               | a qualifying applied frame lacked `hostActiveAuthoritative` (see above)                                                 |
| `H-B`               | a qualifying stream (`subscribe`/`subscribeAll`) applied over the last client write                                     |
| `H-D`               | `activate` responses landed out of send order                                                                           |
| `unknown`           | none of the above; no qualifying frame after the last client write, direction not attributable                          |

`diagnosis` is a factual direction string recorded for red points
(`client-ahead-host`, `host-did-not-follow-write`, `projection-lag`, ...). The
earlier `host-moved-after-write` label was wrong for this defect and is gone.

## INVALID

A sample point is INVALID and excluded from green/red when any of these holds:

- `hostPersistedOk=false` (host persisted state unreadable);
- `hasStore=false` or the active group is missing;
- topology precondition fails: `<2` tabs, `<2` groups, or the driven A/B tabs
  are not in different groups;
- baseline host state read failed;
- the T1 trace is unavailable for that read.

Invalid points are counted separately. `verdict.reproduced` is true only for
valid red points.

`verdict.conclusive` is emitted but is **forced to `false`** in this pass with a
`conclusiveReason`, because the INVALID-hardening work (projection unavailable
and failed quick create/close still count as red) is not implemented yet. Treat
`reproduced=false` as "no valid red", not as a signed "not reproduced".

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
    "green": 12,
    "red": 0,
    "invalid": 0,
    "conclusive": false,
    "conclusiveReason": "fix B not implemented: …",
    "perspective": "host-persisted + device-projection + client DOM/store (host memory UNKNOWN)",
    "hostMemory": "UNKNOWN",
    "hostMemorySource": "unavailable",
    "byScenario": {},
    "redSamples": [],
    "invalidSamples": []
  }
}
```

`matches` on each read now contains `domHostPersisted` / `storeHostPersisted`
instead of the removed memory fields. Terminal output prints one line per
sample point with both reads, host persisted, the attribution token, and the
last decision / H-A-candidate frames for red points.

## Notes / limits

- Host memory is not observed. H-B (memory vs persisted inside the host) is not
  judged; a green covers host persisted + per-device projection + client
  DOM/store only. Reading host memory needs a host debug RPC or a privileged
  probe, not a relabelled persisted file.
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
