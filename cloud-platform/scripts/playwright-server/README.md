# Playwright Server (final: PS-1 core + PS-2 extensions + PS-3 prototype diff + PS-4 examples)

Resident, headless-browser test infrastructure for the cloud platform. One Chromium
process holds one `BrowserContext` per identity (`admin`, `zhangsan`, `lisi`), a tab
registry, and a loopback HTTP control plane. Exploration agents inject scripts into
tabs; the same journey file also runs standalone with `node`.

This directory is ops/test infrastructure. It imports only `node:*`, `playwright`
and its own files — never product code under `src/`, `cloud-platform/apps/` or
`tests/e2e/`.

## Start

```bash
# local platform must already be up (https://127.0.0.1:18787)
node cloud-platform/scripts/local-env-reseed.mjs

# resident server (default port 9223, loopback only, headless)
node cloud-platform/scripts/playwright-server/server.mjs \
  --base https://127.0.0.1:18787 \
  --evidence-dir cloud-platform/evidence/ps1-server-core
```

Flags / env:

| Flag             | Env                                               | Default                                    |
| ---------------- | ------------------------------------------------- | ------------------------------------------ |
| `--port`         | `ORCA_PW_SERVER_PORT`                             | `9223` (`0` = random)                      |
| `--base`         | `ORCA_QA_BASE`                                    | `https://127.0.0.1:18787`                  |
| `--evidence-dir` | `ORCA_PW_EVIDENCE_DIR`                            | `cloud-platform/evidence/ps1-server-core`  |
| `--state-dir`    | `ORCA_PW_STATE_DIR`                               | `<evidence-dir>/state`                     |
| `--token`        | `ORCA_PW_SERVER_TOKEN`                            | random per start                           |
| `--scripts-dir`  | `ORCA_PW_SERVER_SCRIPTS_DIRS` (`:`/`;` separated) | adds script roots                          |
| `--ensure-env`   | —                                                 | probe `--base` and exit 2 when unreachable |

On start the server probes `--base`. If the platform is unreachable it prints a
warning with the `local-env-reseed.mjs` command and keeps running; with
`--ensure-env` the same probe is fatal (exit 2). The probe only checks — it never
rebuilds the environment or restarts a running platform.

On listen the server writes `<evidence-dir>/server.json` (mode 0600) with
`{pid,port,url,token,baseUrl,startedAt}`. `GET /status` is anonymous; every other
endpoint requires `Authorization: Bearer <token>`. Host must be
`127.0.0.1:<port>`; cross-origin `Origin` headers are refused. Stop with
`POST /shutdown`, SIGTERM or SIGINT.

## Endpoints

| Method | Path                   | Body                                                       | Purpose                                            |
| ------ | ---------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| GET    | `/status`              | —                                                          | readiness, port, profiles, tab count (anonymous)   |
| GET    | `/tabs`                | —                                                          | `[{id,profile,url,title,active,frames,createdAt}]` |
| POST   | `/tabs`                | `{profile,url}`                                            | open a tab (new context per profile)               |
| POST   | `/tabs`                | `{id,url}`                                                 | navigate an existing tab                           |
| POST   | `/tabs/:id/execute`    | `{source}` / `{path}` / `{script}`, `{params?,timeoutMs?}` | run a script against that tab                      |
| POST   | `/tabs/:id/screenshot` | `{path?,fullPage?}`                                        | screenshot into `<evidence-dir>` only              |
| DELETE | `/tabs/:id`            | —                                                          | close a tab (204)                                  |
| POST   | `/shutdown`            | —                                                          | graceful stop                                      |

`execute` returns `{ok,runId,result,steps,logs,durationMs,error?}` and writes
`runs/<runId>/{result.json,logs.txt,shots/}`. Inline `source` is a function
expression called as `({page, ui, context, params, log}) => …`; `path`/`script`
loads a journey module (default export) and calls its `run` with the same context.
Script paths must resolve inside this directory or an allowed `--scripts-dir`.

### curl

```bash
E=cloud-platform/evidence/ps1-server-core/server.json
TOKEN=$(node -p "require('./$E').token")
PORT=$(node -p "require('./$E').port")
H="authorization: Bearer $TOKEN"

# Use 127.0.0.1, not localhost: the Host header check rejects other names.
curl -s 127.0.0.1:$PORT/status
curl -s -H "$H" -H 'content-type: application/json' -d '{"profile":"zhangsan","url":"https://127.0.0.1:18787/"}' 127.0.0.1:$PORT/tabs
curl -s -H "$H" -H 'content-type: application/json' \
  -d '{"script":"example-journey.mjs","params":{"role":"zhangsan"}}' \
  127.0.0.1:$PORT/tabs/t1/execute
curl -s -H "$H" -H 'content-type: application/json' -d '{"fullPage":true}' \
  127.0.0.1:$PORT/tabs/t1/screenshot
curl -s -X DELETE -H "$H" 127.0.0.1:$PORT/tabs/t1
curl -s -X POST -H "$H" 127.0.0.1:$PORT/shutdown
```

## Two-layer scripts

- **Layer 1 `ui`** (`ui.mjs`): `login(role)`, `logout()`, `navigateMenu(route)`,
  `openProject(key)`, `click(target)`, `fill(target,value)`, `assertText(text,scope?)`,
  `text(target)`, `screenshot(name)`, plus `page`, `locator()`, `frame()`, `log`,
  `step`, `steps`, `logs`. Targets accept a CSS string or
  `{testid}`, `{role,name}`, `{label}`, `{text}`, `{css}`.
- **Layer 2**: the real Playwright `page`, locators and frames are passed through.

A journey is one file for both modes:

```js
import { defineJourney, runIfMain } from './journey-runtime.mjs'

const journey = defineJourney({
  name: 'example-journey',
  async run({ ui, page, params }) {
    await ui.login(params.role ?? 'zhangsan')
    await ui.navigateMenu('workbench')
    await ui.assertText('全部项目')
    return { docTitle: await page.title(), crumbs: await ui.text('#crumbs') }
  }
})

await runIfMain(import.meta.url, journey) // standalone only; no-op in server mode
export default journey
```

Server mode:

```bash
curl .../tabs/t1/execute -d '{"script":"example-journey.mjs"}'
```

Standalone mode (fresh temporary Chromium, same `run` body):

```bash
ORCA_QA_BASE=https://127.0.0.1:18787 \
ORCA_PW_EVIDENCE_DIR=cloud-platform/evidence/ps1-server-core/standalone \
node cloud-platform/scripts/playwright-server/example-journey.mjs
```

Standalone exits 0 on success and 1 on failure; prints a JSON payload with
`steps` and `error.failedStep` on stdout (step logs go to stderr). `defineJourney` and `runIfMain` live in
`journey-runtime.mjs`.

Identity credentials default to the reseed demo accounts (`admin/Adm1n!`,
`zhangsan/Passw0rd!`, `lisi/Passw0rd!`); override with `ORCA_PW_ROLE_MAP` JSON.
Successful logins persist `storageState` to `<state-dir>/<profile>.json`, so a
restart keeps each identity logged in.

## Extended function library (16 helpers from PS-2, plus PS-3 compare)

`ui-extensions.mjs` attaches to the same `ui` namespace in both modes. Extraction
comes first (exploratory-testing-method §9b): read region text/state and assert,
use screenshots only for layout evidence. Every helper is a thin Playwright
wrapper and keeps `page` as the escape hatch.

| Group    | Signature                        | Returns                                                                   |
| -------- | -------------------------------- | ------------------------------------------------------------------------- |
| extract  | `extractText(scope?, selector?)` | `{text, sections[], kv[]}`                                                |
| extract  | `extractLayout(pageId?)`         | `{route, viewport, nav[], blocks[]}`                                      |
| extract  | `extractState()`                 | `{states[], badges[], counts[], stats[]}`                                 |
| extract  | `extractTable(selector?)`        | `[{columns[], rowCount, rows[]}]`                                         |
| act      | `login(username?, opts?)`        | `{username, reused}` (role key or account)                                |
| act      | `logout()`                       | `{reused}`                                                                |
| act      | `navigateMenu(pageIdOrLabel)`    | crumb text                                                                |
| act      | `openProject(id)`                | `{id, found, text}`                                                       |
| act      | `openDetail(id?)`                | `{title, text, kv[]}` (dialog left open)                                  |
| act      | `openWorkspace(id, opts?)`       | `{status: ready\|failed\|pending\|blocked}`                               |
| act      | `openTab(type, arg?)`            | `{type, activeTab}` — `files\|git\|file\|diff\|terminal\|activate`        |
| act      | `saveFile()`                     | `{saved, dirtyTabs}`                                                      |
| act      | `switchDiff(mode)`               | `{mode}` — `inline\|side-by-side`                                         |
| act      | `fillForm(fieldMap, opts?)`      | `{filled[], submitted}` — keys are labels/ids; `$submit` or `opts.submit` |
| assert   | `assertText(expected, scope?)`   | `true` (throws on miss)                                                   |
| assert   | `waitForState(text, opts?)`      | `{found, line}`                                                           |
| discover | `discover()`                     | `{route, controls:{buttons,inputs,links,tables,tabs}}`                    |
| discover | `compareWithPrototype(pageId?)`  | `{status:'ok', diffFile, reportFile, summary, acceptance}` (PS-3)         |
| evidence | `screenshot(name, opts?)`        | file path                                                                 |

Workspace helpers (`openTab/saveFile/switchDiff`) act inside the
`cloud-admin.html` iframe, so call `openWorkspace` first. JSDoc above each
function carries a runnable example.

### Extension demo (both modes)

```bash
# standalone
ORCA_QA_BASE=https://127.0.0.1:18787 \
ORCA_PW_EVIDENCE_DIR=cloud-platform/evidence/ps2-extensions/standalone \
node cloud-platform/scripts/playwright-server/extension-demo.mjs

# server mode
curl .../tabs/t1/execute -d '{"script":"extension-demo.mjs","params":{"role":"admin"}}'
```

The demo extracts workbench text/state, asserts, opens a project detail dialog,
extracts the table, then inventories controls and layout.

### Examples (PS-4, both modes)

| File                     | Mode        | What it shows                                                                 |
| ------------------------ | ----------- | ----------------------------------------------------------------------------- |
| `example-journey.mjs`    | smoke       | minimal login → workbench → assert → return evidence                          |
| `extension-demo.mjs`     | smoke       | extraction-first loop: extractText/State → assert → detail → extractTable     |
| `example-explore.mjs`    | exploration | `discover` → `extractText`/`extractState` → findings-shaped `{meta,findings}` |
| `example-regression.mjs` | regression  | login → open project detail → assertion chain; exits 1 on first failure       |

`example-explore.mjs` records non-blocking observations as findings (M116 shape:
`id/severity/page/title/steps/expected/actual/evidence`) instead of aborting.
`example-regression.mjs` throws on the first broken assertion, so standalone
`node` exit codes make it a CI gate.

```bash
# exploration, standalone
ORCA_QA_BASE=https://127.0.0.1:18787 \
ORCA_PW_EVIDENCE_DIR=cloud-platform/evidence/ps4-final/standalone \
node cloud-platform/scripts/playwright-server/example-explore.mjs

# regression, standalone (exit 1 = first failed step in error.failedStep)
ORCA_QA_BASE=https://127.0.0.1:18787 \
ORCA_PW_EVIDENCE_DIR=cloud-platform/evidence/ps4-final/standalone \
node cloud-platform/scripts/playwright-server/example-regression.mjs

# server mode (same files)
curl -s -H "$H" -H 'content-type: application/json' \
  -d '{"script":"example-explore.mjs","params":{"role":"admin"}}' \
  127.0.0.1:$PORT/tabs/t1/execute
```

## Prototype comparison (PS-3)

`prototype-inventory.mjs` runs **one** browser-side extractor over both
`remote-connectivity/design/2026-11-13-cloud-dev-platform/ui/prototype.html`
(`file://`) and the running Web. Each role runs in its own isolated
`BrowserContext`; the prototype side also switches its admin/developer demo role.
The unified inventory captures
`nav/sections/stats/tables/fields/actions/menus/dialogs/drawers/frames/tokens`,
including hidden dialogs, drawers and context menus on the prototype.

Role drivers live in `prototype-collect.mjs`; `prototype-diff.mjs` re-exports the
public API, with the comparators in `prototype-diff-{layout,fields,menus}.mjs`
and the writer in `prototype-report.mjs`.

`prototype-diff.mjs` then detects three classes:

| Class  | Comparator                                                                  | Severity |
| ------ | --------------------------------------------------------------------------- | -------- |
| layout | page reachability, nav/section order (LCS), stats, table column order/count | P0/P1/P2 |
| field  | label normalize -> alias table -> Dice >= 0.75, then id/type/required/state | P1/P2    |
| menu   | sidebar, page actions, context menus, dialog buttons by label + role        | P1/P2    |

```bash
ORCA_BACKGROUND_LAUNCH=1 node cloud-platform/scripts/playwright-server/prototype-compare.mjs \
  --base https://127.0.0.1:18787 \
  --evidence-dir cloud-platform/evidence/ps3-prototype-diff
```

Writes `inventory-{prototype,actual}-{admin,developer}.json`, `diff.json` and
`report.md`. The CLI exits 1 unless all six predictable differences from design
§4.5 are detected (nav/page rename, workbench stat rename, missing 「最近使用」
column, missing `diagnostics` route, P3 overlay+iframe, login id drift).

From a journey or server injection, the same run is one call:

```js
const parity = await ui.compareWithPrototype('workbench')
parity.acceptance.passed // true when 6/6 known differences were detected
```

Workspace comparison opens a project into the same-page overlay and inventories
the `cloud-admin.html` iframe entry; prototype dialogs are static, so the diff
reports unopened Web overlays as findings rather than guessing. Screenshots are
deliberately not a gate (font rendering and demo data differ).

## Integration with exploration agents

The shipped control plane is tab-oriented: one resident server, one tab per
surface, and `execute` is the injection point. There is intentionally no
`/runs` queue or WS event stream in v1 — `execute` returns the full run payload
synchronously, and `node` standalone mode covers chained regression runs.

1. Start the platform (`local-env-reseed.mjs`) and the server once; read
   `<evidence-dir>/server.json` for `port`/`token`/`baseUrl`.
2. `POST /tabs {profile,url}` per identity/surface. Each profile has its own
   `BrowserContext`; tabs keep DOM and login state across injections, so an
   exploration session never pays a cold browser rebuild.
3. `POST /tabs/:id/execute` with either:
   - `{source}` — a throw-away probe as a function expression or statement body
     `({page,ui,context,params,log}) => …`;
   - `{script}` — a `defineJourney` file in this directory (allow-listed path).
4. Use `example-explore.mjs` as the exploration template: login → navigate →
   `discover`/`extractText`/`extractState`/`extractTable` → return
   `{meta, findings, summary}`. Findings use the M116 shape
   (`id/severity/page/title/steps/expected/actual/evidence`); observations that
   should not abort the run are recorded instead of thrown. Prefer extraction
   over screenshots (method §9b); screenshots are layout evidence only.
5. Evidence: each execute writes `runs/<runId>/{result.json,logs.txt}`;
   `ui.screenshot()` and `POST /tabs/:id/screenshot` write under the evidence
   dir. `GET /tabs` addresses surfaces by stable `t1,t2,…` ids.
6. Promote a probe into a regression file like `example-regression.mjs` (its
   assertions throw). Run it standalone in CI: exit 0 passes, exit 1 reports the
   first failed step in `error.failedStep`.
7. Keep one server instance for the whole session, but restart it after changing
   platform/server code — see Troubleshooting.

## Troubleshooting

| Symptom                                          | Cause / fix                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.json` never appears, process exits early | Port already in use (`EADDRINUSE`) or a bad flag. Retry with `--port 0` and read stderr.                                                                                                                                                                                                                             |
| `WARN base unreachable`                          | Platform is down or `--base` is wrong. Start it with `node cloud-platform/scripts/local-env-reseed.mjs`. Node-side callers need the dev CA (`NODE_EXTRA_CA_CERTS=~/orca-local-env/tls/ca.pem`); browser contexts already use `ignoreHTTPSErrors`.                                                                    |
| **18787 long-running instance is stale**         | A resident platform keeps serving the `apps/web`/`apps/api` code it started with, so DOM changes and new fixtures never appear. After changing either app, restart it: `node cloud-platform/scripts/local-env-reseed.mjs --restart-platform`, then restart the Playwright Server so open tabs reload the new bundle. |
| `server.json` points at a dead port              | Stale discovery file from a previous instance. Check `/status` / `pid`; delete `server.json` (or use a fresh `--evidence-dir`) before starting again.                                                                                                                                                                |
| Login screen never advances                      | Persisted `storageState` for that profile is stale. Delete `<state-dir>/<profile>.json`, use a fresh `--state-dir`, or call `ui.login(role,{relogin:true})`.                                                                                                                                                         |
| `403 BAD_HOST` / `403 BAD_ORIGIN`                | Call the control plane as `127.0.0.1:<port>` (not `localhost`), and do not send a cross-origin `Origin` header.                                                                                                                                                                                                      |
| `403 script path not allowed`                    | `script` must resolve (via `realpath`) inside this directory or a `--scripts-dir` root.                                                                                                                                                                                                                              |
| Execute times out                                | Default 120 s. A synchronous infinite loop cannot be aborted; pass `timeoutMs`, ensure loops `await`, or use the documented `isolate` upgrade path.                                                                                                                                                                  |
| `400 path escapes evidence directory`            | Screenshot artifact paths must stay under `--evidence-dir`; use relative paths.                                                                                                                                                                                                                                      |
| Tabs from a previous run are gone                | Tabs are in-memory and die with the browser process. Logins survive through `storageState`; page DOM does not.                                                                                                                                                                                                       |
| Wrong data or sessions during exploration        | Exploration deliberately reuses warm sessions. Run reseed (or use a fresh `--state-dir`) when you need clean data; regression accepts the current data by design.                                                                                                                                                    |

## Tests

```bash
node --test cloud-platform/scripts/playwright-server/server.test.mjs \
  cloud-platform/scripts/playwright-server/prototype-diff.test.mjs

# example gate: both modes must pass
ORCA_QA_BASE=https://127.0.0.1:18787 ORCA_PW_EVIDENCE_DIR=cloud-platform/evidence/ps4-final/standalone \
  node cloud-platform/scripts/playwright-server/example-explore.mjs
ORCA_QA_BASE=https://127.0.0.1:18787 ORCA_PW_EVIDENCE_DIR=cloud-platform/evidence/ps4-final/standalone \
  node cloud-platform/scripts/playwright-server/example-regression.mjs
```

`server.test.mjs` covers server start/stop, `/status`, auth, tab lifecycle, inline
execute, screenshot path confinement, and the same journey file in both modes;
its journey test skips when the platform at `ORCA_QA_BASE` is unreachable.
`prototype-diff.test.mjs` covers the pure diff functions (label normalization,
Dice, LCS, severity) without a browser.

## Safety notes

- Headless only; no `show()`, window focus or OS activation. Screenshots are CDP.
- Loopback binding + bearer token + Host/Origin checks. `node:vm` is not used as
  a security boundary; scripts are trusted local code. A synchronous infinite
  loop can still block the server — runs have a timeout, but cannot abort a
  synchronous loop. `isolate:true` (launchServer/connect) is the documented
  later upgrade path.
- Screenshot/artifact paths are resolved inside `--evidence-dir`.
- No product-code imports; Electron E2E specs (`tests/e2e/`) are untouched.
