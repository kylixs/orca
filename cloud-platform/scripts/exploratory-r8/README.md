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
- Output: `cloud-platform/evidence/exploratory-r8/u138-timeline.json`
  (gitignored) plus an immutable per-run copy under
  `evidence/exploratory-r8/run-<ts>/` (`u138-timeline.json`, `summary.json`).

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
   `opened` → close it → sample `closed`.

Every sample point is **dual-read**: initial read → wait `U138_SETTLE_MS`
(≥2 s) → re-read. A point is `consistent` only when both reads agree with each
other and all views agree; disagreement between reads is a red (`unstable`),
never a green.

## Three independent reads

Each read records, with its own timestamp:

- **host memory** active: there is no RPC for host memory, so it is read from
  `profile-state.db` (`workspaceSession.activeTabIdByWorktree`) and explicitly
  labelled `hostMemorySource: "persisted-file-fallback"`. If the file/key
  cannot be read the read is `hostMemoryOk=false` and the point is INVALID.
- **host persistent** active: the same persisted field, labelled
  `profile-state.db:workspaceSession.activeTabIdByWorktree`.
- **device projection**: `session.tabs.list` from the web client. This is a
  per-device projection and is asserted separately; it never substitutes for
  host memory.

DOM and store are read alongside them. DOM is scoped to `.app-layout` and
visible nodes only; store active is the active group only (no `groups[0]`
fallback). `activeTabIdByWorktree` is the focus/terminal id and is recorded as
corroborating evidence, not as the group's active tab.

## Apply telemetry (H-A)

`addInitScript` sets `localStorage['orca.debug.sessionTabs']='1'` before any
page script, so the T1 renderer tracer (`window.__orcaSessionTabsTrace`) is on
from the first frame. Each sample records the last trace frame and the last
frame carrying an apply decision (`applied`, `applyOptions.hostActiveAuthoritative`)
before the DOM read timestamp. H-A is `affirmative` when the last winning
(`applied=true`) frame was applied without `hostActiveAuthoritative=true` —
including the case where `applyOptions` is absent, which means the apply did
not adopt the host active. A later decision frame with `applied=false` is a
rejected (stale) frame and does not answer H-A. With no winning frame the
verdict is `undetermined` (reported, never guessed).

## INVALID

A sample point is INVALID and excluded from green/red when any of these holds:

- `hostMemoryOk=false` (host persisted state unreadable);
- `hasStore=false` or the active group is missing;
- topology precondition fails: `<2` tabs, `<2` groups, or the driven A/B tabs
  are not in different groups;
- baseline host state read failed;
- the T1 trace is unavailable for that read.

Invalid points are counted separately. `verdict.reproduced` is true only for
valid red points.

## Output

`evidence/exploratory-r8/u138-timeline.json` plus
`run-<ts>/summary.json`:

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
        "hostMemoryActive": "…",
        "hostPersistentActive": "…"
      },
      "second": {
        "domActive": ["web-terminal-…"],
        "storeActive": "…",
        "projectionActive": "…::…",
        "hostMemoryActive": "…",
        "hostPersistentActive": "…"
      },
      "hA": {
        "verdict": "negative",
        "reason": "session.tabs.listAll applied with hostActiveAuthoritative=true"
      },
      "attribution": { "token": "green", "reason": "all views agree in both reads" }
    }
  ],
  "verdict": {
    "green": 12,
    "red": 0,
    "invalid": 0,
    "byScenario": {},
    "redSamples": [],
    "invalidSamples": []
  }
}
```

Terminal output prints one line per sample point with both reads, the
attribution token, and the last applied frame's `applied` /
`hostActiveAuthoritative` values for red points.

## Notes / limits

- No host-memory RPC exists, so `hostMemoryActive` is the persisted value with
  an explicit fallback label. H-C (device projection vs host) is still
  detectable by comparing projection with the persisted value; memory-vs-persist
  lag within the host is not independently observable without a reboot/debug RPC.
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
