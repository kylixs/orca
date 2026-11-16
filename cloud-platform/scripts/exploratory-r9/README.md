# exploratory-r9 · U162 v3 e2e (durable active resume)

Committed copy of the script behind the U162 v3 evidence
(`cloud-platform/evidence/u162-e2e/v3-*.json`). It drives a hidden Playwright
chromium against a live local Orca Web host: device A activates a second
top-level tab, then a separate browser context with **no recorded selection**
opens the same worktree and must resume the durable (persisted) active tab.

Every run writes an evidence JSON whose top level carries `scriptPath`,
`scriptSha256`, and `gitCommit`, so the run is traceable to this file.

## Entry

| Item               | Value                                                                      |
| ------------------ | -------------------------------------------------------------------------- |
| Platform / console | `https://127.0.0.1:18787/` (self-signed)                                   |
| Console route      | `#/projects` (`#projectBody` table)                                        |
| Login              | `zhangsan` / `Passw0rd!`                                                   |
| Project            | `zhangsan-demo`                                                            |
| Workspace entry    | row button `button[data-orca-web]` → popup                                 |
| Host state         | `~/orca-local-env/host/ud` and `~/orca-local-env/host2/ud` (`profile-state.db`) |
| Dependency         | repo `node_modules` (uses `playwright`); run the script from the repo      |

## Environment overrides (`U162_*`)

- `U162_PLATFORM_URL` — console origin (default `https://127.0.0.1:18787`)
- `U162_USERNAME` / `U162_PASSWORD` — console login
- `U162_PROJECT_KEY` — project row to open (default `zhangsan-demo`)
- `U162_OUT_MAIN_SHA` — recorded as `buildProof.outMainSha256`
- `U162_REPO_ROOT` is **not** read; `REPO_ROOT` is the absolute repo path in the
  script header. Adjust it if the checkout moves.

## Reads and assertions

Each read records:

- **projection** — `session.tabs.list` over the real wire (per-device projection)
- **persisted** — read-only SQLite of `profile-state.db`
  (`workspaceSession.activeTabIdByWorktree`)
- **T1 trace** — `window.__orcaSessionTabsTrace.dump()`
- **preOverrideSnapshotActiveTabId** — the shared snapshot value at the projected
  `snapshotVersion`, taken from a peer device's `session.tabs.*` frame, i.e. what
  the snapshot held before the read-side durable override

Assertions: baseline projection agrees with persisted; the activation moves
persisted to the target; the device with no recorded selection projects the
target and matches persisted; that read does not mutate persisted; device A is
re-read **after** the fresh read and still selects the target; after switching
back, A and another fresh device both settle on the baseline tab.

Timing: after each activation the script polls the on-disk persisted value (100 ms
steps, 2 s cap) instead of a fixed sleep.

## Run

```bash
node cloud-platform/scripts/exploratory-r9/u162-v3-e2e.mjs
```

Hidden chromium only; no Orca window is shown.
