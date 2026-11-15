# Playwright Server (PS-1 core)

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

| Flag             | Env                                               | Default                                   |
| ---------------- | ------------------------------------------------- | ----------------------------------------- |
| `--port`         | `ORCA_PW_SERVER_PORT`                             | `9223` (`0` = random)                     |
| `--base`         | `ORCA_QA_BASE`                                    | `https://127.0.0.1:18787`                 |
| `--evidence-dir` | `ORCA_PW_EVIDENCE_DIR`                            | `cloud-platform/evidence/ps1-server-core` |
| `--state-dir`    | `ORCA_PW_STATE_DIR`                               | `<evidence-dir>/state`                    |
| `--token`        | `ORCA_PW_SERVER_TOKEN`                            | random per start                          |
| `--scripts-dir`  | `ORCA_PW_SERVER_SCRIPTS_DIRS` (`:`/`;` separated) | adds script roots                         |

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

curl -s localhost:$PORT/status
curl -s -H "$H" -H 'content-type: application/json' -d '{"profile":"zhangsan","url":"https://127.0.0.1:18787/"}' localhost:$PORT/tabs
curl -s -H "$H" -H 'content-type: application/json' \
  -d '{"script":"example-journey.mjs","params":{"role":"zhangsan"}}' \
  localhost:$PORT/tabs/t1/execute
curl -s -H "$H" -H 'content-type: application/json' -d '{"fullPage":true}' \
  localhost:$PORT/tabs/t1/screenshot
curl -s -X DELETE -H "$H" localhost:$PORT/tabs/t1
curl -s -X POST -H "$H" localhost:$PORT/shutdown
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

## Integration with exploration agents

1. Start the server once; read `server.json`.
2. `POST /tabs {profile,url}` per surface the agent wants to inspect. Tabs and
   logins survive across injections — no cold browser rebuild.
3. `POST /tabs/:id/execute` with either the agent's inline function source or a
   registered journey file. Context is isolated per `profile`.
4. Pull screenshots/`runs/<runId>` as evidence; `GET /tabs` addresses them by id.
5. Promote a successful exploration snippet into `example-journey.mjs`-style
   `defineJourney` files and run them standalone in regression.

## Tests

```bash
node --test cloud-platform/scripts/playwright-server/server.test.mjs
```

Covers server start/stop, `/status`, auth, tab lifecycle, inline execute,
screenshot path confinement, and the same journey file in both modes. Journey
tests skip if the local platform at `ORCA_QA_BASE` is unreachable.

## Safety notes

- Headless only; no `show()`, window focus or OS activation. Screenshots are CDP.
- Loopback binding + bearer token + Host/Origin checks. `node:vm` is not used as
  a security boundary; scripts are trusted local code. A synchronous infinite
  loop can still block the server — runs have a timeout, but cannot abort a
  synchronous loop. `isolate:true` (launchServer/connect) is the documented
  later upgrade path.
- Screenshot/artifact paths are resolved inside `--evidence-dir`.
- No product-code imports; Electron E2E specs (`tests/e2e/`) are untouched.
