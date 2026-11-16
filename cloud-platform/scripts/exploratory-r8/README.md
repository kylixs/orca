# exploratory-r8 · U138 RPC frame timeline probe

Reusable, read-only probe for U138: after an Orca Web refresh the host's active
tab can disagree with the rendered DOM and the client store. The probe drives
`activate A -> activate B -> refresh` repeatedly and records who wrote what,
when, and over which previous selection.

Product code, `cloud-platform/apps/`, the ledger, and PROGRESS are not modified.

## Files

- `cloud-platform/scripts/exploratory-r8/u138-frame-timeline.mjs` — probe.
- `cloud-platform/scripts/exploratory-r8/u138-frame-timeline-race.mjs` — race-window
  variant: reloads as soon as a renderer `session.tabs.activate` send frame is
  recorded, without waiting for the response/DOM/host publish. Pre-reload frames
  and race metadata are persisted to sessionStorage and drained after the shell
  returns. Knobs: `U138_RACE_DELAY_MS` (default 0), `U138_RACE_SETTLE_MS`
  (default 3000, second post-reload sample).
- Output: `cloud-platform/evidence/exploratory-r8/u138-timeline.json`
  (gitignored, ~141 frames per 3-cycle run); the race variant writes
  `u138-timeline-race.json` (50 samples per 10-cycle run).

## Entry

| Item | Value |
| --- | --- |
| Platform / console | `https://127.0.0.1:18787/` (self-signed) |
| Console route | `#/projects` (`#projectBody` table) |
| Login | `zhangsan` / `Passw0rd!` (also accepts `U138_USERNAME` / `U138_PASSWORD`) |
| Project | `zhangsan-demo` (override with `U138_PROJECT_KEY`) |
| Workspace entry | row button `button[data-orca-web="<projectId>"]` → popup |
| Issued URL | `https://100.67.197.59:18444/h/dev-local-02/web-index.html?api=…#handoff=…&project=…` (edge URL; the hash is wiped after redemption) |

The probe opens a fresh browser context, so the handoff mints a new paired
device; per-device tab selection is namespaced to that device. It snapshots the
host's active tab on entry and restores it with `session.tabs.activate`
(`notifyClients:false`) if the run moved it. Created tabs (only when the
workspace has fewer than two) are closed at the end. No process is killed except
the Playwright browser this script spawns — no wide `pkill`.

## Run

```bash
node cloud-platform/scripts/exploratory-r8/u138-frame-timeline.mjs
U138_PROJECT_KEY=zhangsan-demo U138_CYCLES=3 \
  node cloud-platform/scripts/exploratory-r8/u138-frame-timeline.mjs
```

Environment knobs: `U138_PLATFORM_URL`, `U138_USERNAME`, `U138_PASSWORD`,
`U138_PROJECT_KEY`, `U138_CYCLES`, `U138_HEADLESS=0`, `U138_PAGE_FRAME_LIMIT`.

## Steps (entry → drive → sample)

1. `addInitScript` installs both recorders before any page script:
   - `window.api` wrapper: plaintext RPC send/recv frames (method, params,
     response id/result/error) for `session.tabs.*`;
   - `WebSocket` wrapper: transport evidence (E2EE control frames, encrypted
     frame/byte counts). The RPC timeline is authoritative because every frame
     after `e2ee_hello` is E2EE ciphertext at the socket layer.
2. Log in on the console, open `#/projects`, click the project's **Orca Web**
   button, wait for `.app-layout`, dismiss the onboarding tip (Escape / “Got it”).
3. Wait until `window.__store` reports `activeWorktreeId` and at least one
   `[data-tab-id]`. If fewer than two tabs exist, create one via the `New tab`
   menu (`New Terminal`).
4. For each cycle: sample `start` → click tab A → sample `activate-a` → click
   tab B → sample `activate-b` → `page.reload()` → wait for the shell → sample
   `after-reload`. Default 3 cycles (4 samples each).
5. Each sample reads three views and cross-checks them:
   - **DOM** `[data-tab-id][data-active="true"]` (SortableTab / BrowserTab /
     EditorFileTab roots); `data-tab-title` for the label.
   - **Store** active group of `activeWorktreeId` →
     `groupsByWorktree[wt].activeTabId`; also records `activeTabIdByWorktree`,
     browser/editor ids, groups, unified tabs.
   - **Host** `session.tabs.list` probe through the raw RPC call
     (read-only, marked `source:"probe"`), returning `activeTabId`,
     `activeTabType`, `activeGroupId`, `publicationEpoch`, tabs/groups.
6. Normalize ids before comparing: `web-terminal-<encoded>` → host tab id, and
   host surface id `tab::leaf` → tab part.
7. Restore the pre-run host active tab and close any created tabs.

## Checkpoints

- Three-way agreement per sample: `domActive === storeActive` and
  `comparable(domActive) === tabPart(hostActive)`.
- First inconsistent sample: its global frame index (`frameGidAtSample`).
- Last client write before that sample: `session.tabs.activate|close|
  closeLifecycle|createTerminal|move|setTabProps|updatePaneLayout`, with params
  and the correlated response (`activeTabId` / `activeTabType` /
  `publicationEpoch`), so “who wrote and what it covered” is explicit.
- Last host publish: the latest `session.tabs.subscribe` snapshot
  (`updated` / `snapshots`) and its `activeTabId`.
- Diagnosis tokens: `consistent`, `client-apply-lag`,
  `client-divergence`, `host-moved-after-write`,
  `host-publish-overrode-write`, `write-response-disagrees-with-host`.

## Output

`evidence/exploratory-r8/u138-timeline.json`:

```jsonc
{
  "project": { "key": "zhangsan-demo", "id": "proj_…" },
  "worktreeId": "…",
  "runs": [
    {
      "cycle": 1, "phase": "activate-a",
      "domActive": ["web-terminal-…"], "storeActive": "web-terminal-…",
      "hostActive": "…::…", "hostActiveType": "terminal",
      "consistent": true, "diagnosis": "consistent",
      "frameGidAtSample": 40,
      "frames": [ { "layer": "rpc", "dir": "send", "method": "session.tabs.activate", "params": {}, "gid": 29 } ],
      "lastClientWrite": { "gid": 29, "method": "session.tabs.activate", "params": {}, "response": {} },
      "lastHostPublish": { "gid": 32, "result": { "activeTabId": "…" } }
    }
  ],
  "firstInconsistency": null,
  "verdict": { "cycleCount": 3, "sampleCount": 12, "consistentSamples": 12, "inconsistentSamples": 0, "reproduced": false },
  "isolation": { "baselineHostActive": "…", "finalHostActive": "…", "restored": true }
}
```

Terminal output prints one line per sample with the three views and
`CONSISTENT` / `INCONSISTENT`, then the first inconsistency frame index and,
for an inconsistent sample, the last client write and last host publish.

## Notes / limits

- If the console login or workspace entry is blocked, the script still writes
  partial evidence with `fatalError` / `verdict.blocked`; the recorder and cycle
  skeleton remain reusable.
- The probe calls `session.tabs.list` at sample time; that method may restore
  structured tabs on the host, so probe frames are tagged `source:"probe"` and
  excluded from “last client write”.
- `window.__store` is required for the store view; the web bundle in this
  environment is the instrumented build (`VITE_EXPOSE_STORE=true`). If absent,
  `hasStore` is false and the store comparison degrades to DOM vs host only.
- Tabs live in two split groups in the seeded workspace; the active group's
  active tab is the comparable store id, and the host active is the full
  `tab::leaf` surface.
