# 云端开发平台 · 探索/回归双模式 Playwright Server 设计（只读）

- 日期：2026-11-15
- 作者：设计代理（只读静态分析；未改产品代码、未提交 git）
- 输入：`ui/prototype.html`、`cloud-platform/apps/web/`、`cloud-platform/scripts/exploratory-r2/`、`cloud-platform/evidence/u46-8-assembly/probe-u46-8-browser-journey.mjs`、`cloud-platform/scripts/local-env-reseed.mjs`、`tests/playwright.config.ts`、`tests/e2e/global-setup.ts`、`src/renderer/src/components/editor/monaco-e2e-probe.ts`
- 结论：新增一个**独立于 `tests/e2e` 的常驻 Web 测试守护进程**。一个 Chromium 实例、多身份上下文、多页签驻留；本地 `127.0.0.1` HTTP/WS 接受动态加载与执行脚本；脚本只有一个文件形态，既是探索层的语义旅程，也是可 `node script.mjs` 独立运行的回归脚本。

---

## 0. 结论速览

| 项 | 设计结论 |
| --- | --- |
| 形态 | 独立 Node 进程 `cloud-platform/scripts/playwright-server/`，持有 Playwright Chromium；不依赖 Electron，不 import 任何产品代码 |
| 端口 | 默认 `127.0.0.1:0`（随机端口），启动后把 `{port,token,pid}` 写入 `evidence/playwright-server/server.json`（0600） |
| 协议 | HTTP（控制与执行）+ WS（运行事件流）；仅回环绑定，要求 Bearer token |
| 页签 | `TabRegistry` 以 `t1,t2,…` 稳定 id 管理；支持按 id / URL 片段 / 标题片段 / `active` 寻址；每个页签记录所属身份上下文与 iframe 列表 |
| 登录态 | 每身份一个 BrowserContext，`storageState` 落盘；服务重启后仍登录；`cloud-admin.html` iframe 的 cookie/localStorage 同属该上下文 |
| 脚本 | 单文件 `defineJourney({ run })`：服务模式注入常驻 `page/ui`，独立模式由 `runIfMain` 启动临时 Chromium；两种模式执行同一 `run` |
| 原型对照 | 用**同一个 DOM 清点器**分别驱动 `prototype.html` 与实际 Web，产出结构化清单，再按布局/字段/菜单三类做归一化 diff |
| 与既有 | `tests/e2e/*.spec.ts` 不迁移、`global-setup` 不改；新 server 只服务 Web 平台与云端工作区，Electron 探索仍由 `exploratory-r2` 承担 |
| 安全 | 回环绑定 + token + Host/Origin 校验 + 脚本目录白名单；`node:vm` 不作为安全边界 |
| 验收 | 探索代理连续注入脚本驱动多页签且状态不丢；同一脚本 `node` 独立回归退出 0；原型 diff 能报出已知 6 类差异 |

---

## 1. 既有形态与复用判断

### 1.1 三类既有 Playwright 形态

| 形态 | 位置 | 形态特征 | 本设计的关系 |
| --- | --- | --- | --- |
| Electron E2E spec | `tests/e2e/*.spec.ts` + `tests/playwright.config.ts` | `@stablyai/playwright-test` 的 `_electron.launch()`；`globalSetup` 构建 Electron/CLI/web 并造测试仓库；每 spec 独立 app + userData | **不迁移、不改配置**。回归 spec 继续独立存在 |
| 一次性浏览器 probe | `cloud-platform/evidence/u46-8-assembly/probe-u46-8-browser-journey.mjs` | 真实平台 + 真实 TLS runtime + headless Chromium；登录→项目弹窗→iframe 工作区→文件/编辑器/git/终端；`ignoreHTTPSErrors`；截图 + verdict | 本设计**独立脚本模式**的直接原型；把「每次冷启动浏览器」升级为「常驻实例 + 多页签」 |
| 桌面探索驱动 | `cloud-platform/scripts/exploratory-r2/desktop-harness.mjs`、`driver-*.mjs` | 每个 driver 重新 `_electron.launch`，隔离 HOME/userData，后台 headless；语义 helper 已具备（login/worktree/terminal/dumpUi） | 语义 helper 的命名与职责可借鉴，但 Electron 生命周期不复用；新 server 面向 Web |
| 仪器化先例 | `src/renderer/src/components/editor/monaco-e2e-probe.ts` | 仅 `--mode e2e` 或 `VITE_EXPOSE_STORE=true` 暴露 `window.__monacoEditorE2E` | **不新增产品仪器化**。对照与断言优先真实 DOM / `data-testid` / role / 文本；既有 `data-testid` 足够 |
| 本地环境 | `cloud-platform/scripts/local-env-reseed.mjs` | 幂等重建平台 `https://127.0.0.1:18787`、双 host、demo 仓库、admin/zhangsan/lisi、evidence | server 以**子进程**方式按需调用 reseed，不 import 其模块 |

### 1.2 为什么不是「给现有 spec 加一个 server」

- 现有 spec 的进程模型是「一个 spec 一个 Electron app」；探索需要的是「一个浏览器跨多次注入、跨多页签、跨多轮对话存活」。
- 现有 `playwright.config.ts` 的 `testDir`、`globalSetup`、CI 分片都绑定 Electron；把常驻 Web server 塞进去会污染回归门禁。
- 云端平台 Web 前端（`cloud-platform/apps/web`）与桌面 Electron 是两套 DOM 与入口；探索原型差异的主战场在 Web。

---

## 2. 架构

### 2.1 进程与组成

```
┌─────────────────────────────── playwright-server (node) ───────────────────────────────┐
│  server.mjs                                                                             │
│   ├─ http-routes.mjs ── REST 控制面                                                      │
│   ├─ ws-hub.mjs ─────── 运行事件流（log/step/screenshot/result）                          │
│   ├─ browser-host.mjs ─ chromium 实例 + 每身份 BrowserContext + storageState             │
│   ├─ tab-registry.mjs ─ 页签/iframe 注册表与寻址                                          │
│   ├─ script-registry.mjs ─ 脚本白名单、加载、内联注入                                     │
│   ├─ run-manager.mjs ── 运行生命周期、超时、取消                                          │
│   ├─ lib/ui-api.mjs ─── 第一层语义 API（薄封装 Playwright）                               │
│   ├─ discovery/*.mjs ── 原型/实际 DOM 清点与 diff                                         │
│   └─ journeys/*.mjs ─── 示例旅程（两种模式共用）                                          │
└───────────────┬───────────────────────────────────────────────┬─────────────────────────┘
                │ Playwright protocol                            │ HTTP/WS 127.0.0.1
        ┌───────▼────────┐                              ┌────────▼─────────┐
        │ Chromium       │                              │ 探索代理 / curl   │
        │ ├ ctx(admin)   │                              │ 回归 node 脚本    │
        │ ├ ctx(zhangsan)│                              └──────────────────┘
        │ └ ctx(lisi)    │
        └────────────────┘
```

关键点：

- **一个 Chromium 进程**，每个身份一个 `BrowserContext`。`admin`、`zhangsan`、`lisi` 互不串 cookie；同一身份的多个页签共享登录态。
- 浏览器默认 headless；遵循 AGENTS.md：不 `show()`、不抢焦点、不 OS 激活。截图走 CDP。
- 服务本身不 import `src/**`、`tests/e2e/**`、`cloud-platform/apps/**`。平台只经 HTTP 访问，浏览器只经 Playwright 驱动。
- 依赖：根仓已有 `playwright@1.63.0`、`playwright-core@1.63.0`、`ws@8.22.0`；无需新增依赖。HTTP 用 `node:http`（`tests/e2e/helpers/browser-link-server.ts` 是现成的最小 server 形态）。

### 2.2 启动与发现

```bash
# 1) 幂等重建本地环境（已有则复用）
node cloud-platform/scripts/local-env-reseed.mjs

# 2) 启动常驻 server（默认随机回环端口、headless）
node cloud-platform/scripts/playwright-server/server.mjs \
  --base https://127.0.0.1:18787 \
  --state-dir cloud-platform/evidence/playwright-server/state \
  --evidence-dir cloud-platform/evidence/playwright-server
```

启动后写 `<evidence-dir>/server.json`：

```json
{
  "pid": 12345,
  "port": 18790,
  "url": "http://127.0.0.1:18790",
  "ws": "ws://127.0.0.1:18790/ws",
  "token": "<random>",
  "baseUrl": "https://127.0.0.1:18787",
  "startedAt": "2026-11-15T..."
}
```

停止：`POST /shutdown` 或 SIGTERM。`server.json` 权限 0600；token 同时可用 `ORCA_PW_SERVER_TOKEN` 预置。

### 2.3 HTTP 端点（控制面）

所有请求需 `Authorization: Bearer <token>`（除 `/health` 可选）。`Host` 必须是 `127.0.0.1:<port>`；带 `Origin` 时必须是同源，否则 403。

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/health` | `{ok,browser,profiles,tabs,uptimeMs,baseUrl}` |
| GET | `/tabs` | 页签列表：`[{id,profile,url,title,active,frames[],createdAt}]` |
| POST | `/tabs` | `{profile,url}` 新开页签；返回页签 |
| POST | `/tabs/:id/activate` | 切换活动页签（仅登记，不抢 OS 焦点） |
| POST | `/tabs/:id/navigate` | `{url}` |
| POST | `/tabs/:id/reload` | 重载 |
| DELETE | `/tabs/:id` | 关闭页签 |
| GET | `/tabs/:id/state` | `{url,title,frames,route,h1s,nav,localStorageKeys,cookieNames,consoleErrors}` |
| POST | `/tabs/:id/screenshot` | `{path?,fullPage?}`，仅允许写入 evidence 目录 |
| POST | `/tabs/:id/evaluate` | `{frame?,expression}`，在浏览器沙箱执行并回传 JSON |
| GET | `/profiles` | `[{name,role,loggedIn,cookieNames,storageKeys,tabs}]` |
| POST | `/profiles/:name/login` | `{address?,username?,password?}`；成功后持久化 storageState |
| POST | `/profiles/:name/logout` | 清 cookie/localStorage 并落盘 |
| GET | `/scripts` | 已注册脚本：`[{name,path,sha256,tags}]` |
| POST | `/scripts` | `{name,path}` 注册文件；`{name,source}` 写入 `<state>/runs/<runId>/journey.mjs` 后注册 |
| POST | `/runs` | `{script\|source, mode:"explore"\|"regression", profile?, params?, isolate?}` → `{runId}` |
| GET | `/runs/:id` | `{status,step,steps[],result,logs[],artifacts[],error?}` |
| POST | `/runs/:id/cancel` | 取消运行（尽力）；`isolate` 模式可硬杀子进程 |
| GET | `/prototype/inventory` | `?route=` 原型结构化清单 |
| POST | `/compare/prototype` | `{route\|all,role?}` → 差异报告路径与摘要 |
| POST | `/shutdown` | 优雅关闭浏览器与服务 |

WS `/ws`：客户端先发 `{op:"hello",token}`；随后服务端推送
`{type:"run.started"|"step"|"log"|"screenshot"|"run.result"|"run.error",runId,...}`。
一期只做服务端→客户端事件流；双向 `exec` 通道留到二期（HTTP 已足够注入）。

### 2.4 页签注册表与 iframe

```js
// tab-registry 记录
{ id: 't2', profile: 'zhangsan', page, context, createdAt,
  frames: [{ name: 'main', url }, { name: 'workspace', url: '…/cloud-admin.html…' }] }
```

寻址规则（所有接受 `target` 的端点与 `ui.tab()` 共用）：

1. `t\d+` → 精确 id；
2. `{ url: 'substring' }` / `{ title: 'substring' }` → 首个匹配；
3. `'active'` → 当前身份的活动页签；
4. 缺省 → 该身份最后一个活动页签。

`workspace` frame 的识别：URL 含 `cloud-admin.html`（与 `probe-u46-8-browser-journey.mjs:301`、`run-workspace-exploration.mjs:49` 的既有判定一致）。`ui.frame('workspace')` 返回真实 Playwright `Frame`/`FrameLocator`，后续 locator 自动限定作用域。

### 2.5 登录态驻留

- 身份默认表（可被 `ORCA_PW_ROLE_MAP` JSON 覆盖）：
  `admin/Adm1n!`、`zhangsan/Passw0rd!`、`lisi/Passw0rd!`（与 `local-env-reseed.mjs:35-37` 一致，均为演示值）。
- `login()` 走真实页面登录（`#username/#password/#loginBtn`），成功后 `context.storageState({path:<state-dir>/<profile>.json})`。
- 服务重启时按 `storageState` 恢复；`whoami()` 用 `/v1/me` + 页面状态双重确认。
- 不把 token 写进 evidence；`server.json` 也不含平台密码。

---

## 3. 两层脚本契约

### 3.1 分层

| 层 | 名称 | 内容 | 面向 |
| --- | --- | --- | --- |
| 第一层 | 包装层 `ui` | 稳定语义操作：`login/openProject/tab/click/fill/discover/screenshot/assertText…` | 探索代理，低选择器噪声 |
| 第二层 | 原生 Playwright | `page`、`locator`、`frameLocator`、`expect` 直用 | 回归脚本，可独立运行 |

包装层是**薄封装**：每个 `ui.*` 内部只做「目标解析 + 等待 + 调用真实 Playwright + 记录步骤」。`ui.page`、`ui.locator()`、`ui.frameLocator()` 原样暴露，语义 API 不覆盖的能力随时下落。

### 3.2 单文件脚本形态（两模式共用）

```js
// journeys/login-workbench.mjs
import { defineJourney, runIfMain } from '../lib/journey.mjs'

const journey = defineJourney({
  name: 'login-workbench',
  tags: ['smoke', 'web'],
  prototypeRoutes: ['login', 'workbench', 'projects'],
  async run({ ui, page, expect, log, mode, params }) {
    await ui.login(params.role ?? 'zhangsan')
    await ui.goto('workbench')
    await ui.expectVisible('全部项目')

    // 第一层：语义稳定
    const inventory = await ui.discover('workbench')
    expect(inventory.tables[0].columns).toContain('项目')

    // 第二层：原生 Playwright 随时可用
    await page.getByRole('button', { name: '打开', exact: true }).first().click()
    await ui.frame('workspace').locator('[data-testid="cloud-simple-workspace"]').waitFor()
    await ui.screenshot('workbench-open')
    log('opened', ui.tab().url)
  }
})

await runIfMain(import.meta.url, journey) // 服务模式为 no-op
export default journey
```

- **服务模式**：`POST /runs {script:"login-workbench",mode:"explore"}`。server `import()` 该模块，用常驻页签绑定 `ui/page` 后调用 `journey.run`。
- **独立模式**：`node cloud-platform/scripts/playwright-server/journeys/login-workbench.mjs`。`runIfMain` 检测到「本文件即入口」，启动临时 Chromium + 身份上下文，调用同一个 `run`，打印 JSON，失败退出 1。
- 脚本**不 import `chromium`**；浏览器生命周期只属于运行器。这是两种模式能共用同一文件的关键。
- `defineJourney` 只返回 `{name,tags,prototypeRoutes,run}`，没有隐藏状态。

### 3.3 第一层 `ui` API（v1）

| 组 | 方法 |
| --- | --- |
| 身份 | `login(role,opts)`、`logout()`、`whoami()`、`profile()` |
| 导航 | `goto(route)`、`nav(label)`、`openProject(keyOrId)`、`back()`、`crumbs()` |
| 页签 | `newTab(url)`、`tabs()`、`tab(target)`、`activate(target)`、`close(target)` |
| 作用域 | `frame('workspace'|'main'|srcSubstring)`、`locator(sel)`、`page` |
| 交互 | `click(target)`、`fill(target,value)`、`select(target,value)`、`press(key)`、`hover(target)`、`menu(name)` |
| 目标解析 | `{testid}` / `{role,name}` / `{text}` / `{label}` / `{css}`；缺省顺序 testid → role → text |
| 发现 | `discover(route|tab?)`、`inventory()`、`frames()`、`console()`、`network()` |
| 断言 | `expectVisible`、`expectText`、`expectCount`、`expectRoute`、`expectColumns`、`expectNoConsoleErrors` |
| 产物 | `screenshot(name,{fullPage})`、`snapshot(name)`、`log(...)` |
| 对照 | `comparePrototype({route|all})` |

`expect` 语义：

- 探索模式：断言失败记录为 `{ok:false,step,expected,actual}`，继续执行并可回传报告；
- 回归模式：失败立即抛出，`run.result.status='failed'`，独立进程退出 1。

### 3.4 失败与步骤模型

每个 `ui.*` 与脚本显式 `step(name, fn)` 都写入 `run.steps[]`：
`{name,ok,startedAt,durationMs,detail?,screenshot?}`。探索代理据此定位「哪一步看到了什么」，回归据此给出可读失败点。证据目录：

```
evidence/playwright-server/
  server.json
  runs/<runId>/{result.json,steps.json,logs.txt,shots/*.png}
  prototype-diff/{inventory-prototype.json,inventory-actual.json,diff.json,report.md,shots/*.png}
```

---

## 4. 原型对照

### 4.1 两侧输入

| 侧 | 来源 | 驱动方式 |
| --- | --- | --- |
| 原型 | `remote-connectivity/design/2026-11-13-cloud-dev-platform/ui/prototype.html` | 同一 Chromium 的独立 context 打开 `file://`；按 `data-route` / `data-page` 切换；隐藏的 dialog/drawer/menu 也在静态 DOM 中，可一并清点 |
| 实际 | `https://127.0.0.1:18787/`（`cloud-platform/apps/web`） | 登录后按实际 `data-route` 导航；工作区在同页 overlay + `cloud-admin.html` iframe |

**同一个清点函数** `extractDomInventory(page|frame)` 同时用于两侧，避免「原型用 HTML 解析器、实际用 DOM」造成 schema 漂移。原型额外支持 `role:admin|developer` 两轮，以覆盖原型的前端角色门禁。

### 4.2 清单 schema（归一化）

```js
{
  surface: 'login' | 'workbench' | 'projects' | 'hosts' | 'relays' |
           'members' | 'audit' | 'settings' | 'diagnostics' | 'forbidden' | 'workspace',
  title, breadcrumb,
  nav:     [{ label, group, adminOnly, order }],
  sections:[{ label, kind: 'card'|'stat'|'table-section'|'form'|'list', order }],
  stats:   [{ label, valueShape }],
  tables:  [{ name, columns: [..order], rowCount, sampleRow }],
  fields:  [{ label, type, required, disabled, readonly, placeholder, options[], help }],
  actions: [{ label, role, disabled, title }],
  menus:   [{ name, items: [{ label, disabled, danger }] }],
  dialogs: [{ name, title, fields[], buttons[] }],
  drawers: [{ name, title, fields[] }],
  frames:  [{ kind, src }],
  tokens:  [{ role, fontSize, fontWeight, sidebarWidth, contentPadding, cardRadius }] // 可选
}
```

### 4.3 三类差异的检测

| 类 | 关注对象 | 检测方式 | 判定 |
| --- | --- | --- | --- |
| 布局 | 页面是否存在、导航分组/顺序、区块顺序、统计卡标签、表格列顺序/数量、面包屑 | 有序列表做 LCS；页面/路由做可达性探测（逐个 `data-route` 实际导航，记录 reached/forbidden/missing） | 缺页面/缺主导航=P0；列/区块增删或重排=P1；仅顺序微调=P2 |
| 字段 | 表单 label、类型、必填、禁用/只读、placeholder、下拉选项、帮助文案 | 归一化 label 后匹配：精确 → 别名表 → Dice 相似度 ≥0.75 → missing；再比对属性 | 缺字段/必填性变化=P1；文案/可选性变化=P2 |
| 菜单 | 侧栏项、页面动作按钮、上下文菜单、dialog 按钮、抽屉动作 | 标签+role 集合比对；对原型每个菜单项用 `getByRole`/`getByText` 在实际页面试探，记录 `exact/renamed/missing` | 缺动作/菜单项=P1；禁用态或文案变化=P2 |

归一化规则：NFC、去首尾空白、折叠空白、剥离可选标记（`· 只读`、`（二期）`）、统一「主机管理/主机」等别名。别名表是显式数据文件，命中即报 `renamed`，不静默吞掉。

### 4.4 灵活手段（不止静态 DOM）

1. **结构性**：两侧同一 `extractDomInventory`（主方法）。
2. **可访问性树**：`locator.ariaSnapshot()` 作为与 class 无关的补充结构，帮助区分「换皮」与「真缺」。
3. **选择器试探**：对原型每条动作/字段，按 role/label/text 在实际页面试探，给出命中置信度，定位「改名但仍在」。
4. **截图对照**：固定 1440×900，两侧同页截图并输出并排图；只作人工复核与定位，不作门禁（字体渲染、演示数据不同）。
5. **运行时状态探针**：只比结构/形状，不比演示值；需要值断言时走可配置 baseline。
6. **控制台/网络**：记录 `console.error`、`pageerror`、失败请求，作为差异报告的附注。

### 4.5 已可预见的真实差异（用于设计自检）

静态对照已能确认以下差异，验收 demo 必须能报出：

| # | 类 | 原型 | 实际 Web |
| --- | --- | --- | --- |
| 1 | 菜单 | 侧栏「项目授权」「下载策略」 | 「成员与权限」「平台设置」（`apps/web/index.html:61-63`） |
| 2 | 布局 | 工作台统计：进行中项目/今日会话/可用主机/待审批下载 | 可访问项目/主机在线/禁用下载项目/下载默认策略（`app.js:180-196`） |
| 3 | 布局 | 工作台「全部项目」7 列，含「最近使用」 | 6 列，无「最近使用」（`app.js:199-208`） |
| 4 | 页面 | `#/diagnostics` 连接诊断页 | 实际无 `diagnostics` 路由/渲染器（`app.js:111-119`） |
| 5 | 布局 | P3 项目视图是完整 IDE 路由 | 实际是同页 overlay + `cloud-admin.html` iframe |
| 6 | 字段 | 登录框 id `loginAccount/loginPassword` | `username/password`（label 相同，属 selector 漂移而非字段缺失） |

### 4.6 报告

`report.md`：按 surface 分节，列出 `missing / extra / renamed / reordered / state_drift / copy_drift / layout_drift`，每条带严重度、原型证据（标签/列名）、实际证据（探测结果/截图）、建议。
`diff.json`：机器可读，供后续回归基线或缺陷台账引用。对照本身**不修改任何产品代码**。

---

## 5. 与既有测试体系的关系

| 既有 | 新 server |
| --- | --- |
| `tests/e2e/*.spec.ts` Electron 回归 | 不迁移；新 server 不进入 `tests/playwright.config.ts` 的 `testDir` |
| `tests/e2e/global-setup.ts` 构建 Electron/CLI/web | 不修改；新 server 只消费已构建的 `out/web` 与被 reseed 的平台 |
| `@stablyai/playwright-test` | 新 server 用 `playwright`（同一版本 1.63.0）；独立模式不依赖 test runner |
| `exploratory-r2` Electron 驱动 | 保留；新 server 是 Web 对应物 |
| `probe-u46-8-browser-journey.mjs` | 其旅程步骤可作为首批 journey 的素材；新 server 不再每次冷启动 |
| `local-env-reseed.mjs` | 以子进程调用（`--ensure-env`），或仅做健康探测；不 import |
| `monaco-e2e-probe.ts` | 不新增类似仪器化；优先真实 DOM。`VITE_EXPOSE_STORE` 仅作为既有 web oracle 的说明 |

集成点：

- `--ensure-env`：启动时 `GET <base>/`；不可达则打印一次 `node cloud-platform/scripts/local-env-reseed.mjs` 的提示并以 2 退出（不自动重建，避免探索代理意外重启用户环境）。显式 `--ensure-env` 时才以子进程调用幂等 reseed。
- `--base` 默认 `https://127.0.0.1:18787`，与 reseed 默认端口一致；`NODE_EXTRA_CA_CERTS` 指向 `~/orca-local-env/tls/ca.pem`，浏览器 context 同时 `ignoreHTTPSErrors`。
- 回归模式默认使用新 context（干净登录态），`--keep-state` 可复用探索态。需要干净数据时由调用方先跑 reseed，server 不隐式改数据。

---

## 6. 安全与隔离

### 6.1 端口

- 仅 `listen(port,'127.0.0.1')`；默认 `port=0`。`server.json` 0600。
- `/health` 可匿名（仅返回就绪信息）；其余端点要求 Bearer token。
- 校验 `Host` 头必须是 `127.0.0.1:<port>`；若带 `Origin`，必须是同源。不返回 CORS 头。用于降低本机恶意页面/DNS rebinding 驱动 server 的风险。
- 截图路径、产物路径统一 `path.resolve` 后必须落在 `--evidence-dir` 内，拒绝 `..` 与绝对路径逃逸。

### 6.2 脚本执行边界

| 方案 | 结论 |
| --- | --- |
| `node:vm` | **不作为安全边界**。无 ESM/模块解析，逃逸容易，且无法把 Playwright 句柄安全暴露；只可能用于纯函数片段，本设计不需要 |
| 直接 `import()`（v1 默认） | 用于探索脚本：脚本由同一代理/用户编写，属可信本地代码。收益是可直接使用常驻 `page`、`locator`、`frame`，且步骤流最完整。风险是死循环会阻塞 server → 由 run 超时 + `page.close()` 尽力打断，文档明确「不可中止同步死循环」 |
| 子进程 + Playwright `connect`（`isolate:true`，二期） | `browser-host` 改用 `chromium.launchServer()` 暴露 Playwright endpoint；子进程 `chromium.connect(wsEndpoint)` 得到同一批 context/page。可获得崩溃隔离与硬超时，脚本文件不变。`/tabs/:id/evaluate` 仍在浏览器沙箱内执行 |

脚本白名单：默认只允许 `cloud-platform/scripts/playwright-server/journeys/`；`ORCA_PW_SERVER_SCRIPTS_DIRS` 可追加目录（路径分隔符按平台拆分）。注册时 `realpath` 后做前缀校验。内联 `source` 写入 `<state>/runs/<runId>/` 再 import，不执行网络来源。

### 6.3 与产品零耦合

- server 目录的 import 只允许：`node:*`、`playwright`、`playwright-core`、`ws`。
- 不 import `src/**`、`tests/e2e/**`、`cloud-platform/apps/**`、`local-env-*.mjs`。
- 平台能力只经 HTTP；工作区只经浏览器。
- 可在实现切片加入一条静态自检：扫描 server 目录的 import 说明符，出现禁止前缀即失败。

---

## 7. 实现切分（每令 ≤ 20 分钟）

### O1 · Server 核心（≤20 min）

交付：

- `server.mjs`（参数、生命周期、signal、`server.json`）
- `http-routes.mjs`（health/tabs/new/activate/navigate/close/state/screenshot/shutdown）
- `ws-hub.mjs`（run 事件流）
- `browser-host.mjs`（chromium launch、context、storageState 骨架）
- `tab-registry.mjs`（id、寻址、iframe 识别）

验收：起服 → `GET /tabs` → 新开 2 个页签 → 切换 → 截图落 evidence → `/shutdown` 干净退出；全程 headless、无窗口。

### O2 · 包装层 + 双模式契约（≤20 min）

交付：

- `lib/ui-api.mjs`（登录/导航/页签/交互/断言/截图/发现）
- `lib/journey.mjs`（`defineJourney`、`runIfMain`、`step`、`expect`）
- `lib/standalone-runner.mjs`（临时 Chromium、`ORCA_QA_BASE`、退出码）
- `run-manager.mjs`（运行状态、超时、cancel）

验收：同一 `journeys/login-workbench.mjs` 经 `POST /runs`（explore）与 `node`（regression）都通过；断言改坏后独立模式退出 1 并指出 step。

### O3 · 原型对照（≤20 min）

交付：

- `discovery/extract-dom-inventory.mjs`
- `discovery/extract-prototype.mjs`（file:// + 角色两轮 + 隐藏态）
- `discovery/diff-inventory.mjs`（LCS、别名、Dice、三类分级）
- `discovery/report-writer.mjs`（`diff.json` + `report.md` + 并排截图）
- `compare-prototype.mjs` CLI 与 `POST /compare/prototype`

验收：报告能报出 §4.5 的 6 条已知差异，且 `缺失页面/导航` 为 P0、`缺列/缺字段` 为 P1。

### O4 · 脚本示例 + 环境集成（≤20 min）

交付：

- `journeys/login-workbench.mjs`
- `journeys/open-project-workspace.mjs`（overlay + iframe + 文件/编辑器/终端至少各一步）
- `journeys/prototype-parity.mjs`
- `--ensure-env` 与 `--base/--role-map/--state-dir` 参数收口

验收：探索模式连续注入 3 个脚本，浏览器不重启、登录态不丢、页签可复用；回归模式逐个独立运行。

### O5 · 文档 + 验收 demo（≤20 min）

交付：

- `playwright-server/README.md`：端点表、脚本契约、运行命令、故障排查、安全边界
- 一条 `node --test` 纯函数测试（target 解析 / label 归一化 / LCS）
- 验收证据：`evidence/playwright-server/acceptance/{explore.json,regression.json,prototype-diff.json}`

验收：从空目录按 README 命令可复现 §8 全部项。

---

## 8. 验收标准（基础能力 demo）

1. **常驻与多页签**
   - reseed 后启动 server；`POST /tabs` 打开工作台与「打开项目」两个页签；`GET /tabs` 返回两个 id、profile、URL、iframe 列表。
   - 切换活动页签后，前一页签的登录态与 DOM 状态仍在；浏览器进程不重启。
2. **动态注入**
   - `POST /scripts {path}` 注册文件脚本；`POST /runs {source}` 注入内联脚本；两者都能驱动同一常驻页签。
   - 探索代理连续执行「登录 → 导航 → 打开项目 → iframe 内点击 → 截图 → 返回列表」而不重新登录。
3. **两模式同脚本**
   - `journeys/login-workbench.mjs` 经 `/runs` 执行成功；
   - 同一文件 `node …/login-workbench.mjs` 退出 0；
   - 人为改坏一条断言，独立运行退出 1，输出失败 step 与期望/实际。
4. **原型对照**
   - `POST /compare/prototype {all}` 或 CLI 产出 `diff.json` + `report.md`；
   - 至少命中 §4.5 的 6 条差异；每条有类目、严重度、原型证据、实际证据。
5. **安全/隔离**
   - 无 token 请求返回 401；跨源 `Origin` 返回 403；`127.0.0.1` 之外不可达；
   - 白名单外脚本路径被拒；截图路径逃逸被拒；
   - server 目录无产品代码 import。
6. **不干扰既有**
   - `tests/playwright.config.ts`、`tests/e2e/**`、`global-setup.ts` 无改动；
   - 默认 headless，无 `show()`/`focus()`/OS 激活；
   - `git status` 仅出现本设计与后续实现的新文件。

---

## 9. 风险与限制

| 风险 | 处理 |
| --- | --- |
| 实际 Web 用 `innerHTML` 动态渲染，class/结构易变 | 优先 `data-testid`/role/文本；`discover()` 本身是选择器发现工具；对照结果按结构而非 class |
| 原型是独立 vanilla 实现，非同一 React 组件 | 只做结构/字段/菜单对照与截图复核，不做像素门禁 |
| 打开项目会触发真实 provision/会话 | 回归模式默认干净 context，数据由 reseed 提供；探索模式容忍既有会话 |
| 平台自签 TLS | context `ignoreHTTPSErrors`；Node 侧 fetch 用 `NODE_EXTRA_CA_CERTS` 指向 dev CA |
| 同步死循环阻塞 server | v1 明确限制 + 超时；`isolate:true` 子进程模式作为二期硬隔离 |
| 远程/SSH 主机 | 浏览器只访问平台入口，远端执行仍由平台与 host 承担；server 不新增 SSH 逻辑 |
| Windows | 路径全用 `path`；若 server 派生进程，统一走 `@orca/process-host` 的 `spawnProcess`，禁止裸 `child_process` |
| Playwright 版本漂移 | 固定根仓 `playwright@1.63.0`；不单独安装浏览器 |

---

## 10. 目录与命令（实现落点）

```text
cloud-platform/scripts/playwright-server/
  server.mjs
  http-routes.mjs
  ws-hub.mjs
  browser-host.mjs
  tab-registry.mjs
  script-registry.mjs
  run-manager.mjs
  compare-prototype.mjs
  lib/
    journey.mjs
    ui-api.mjs
    standalone-runner.mjs
  discovery/
    extract-dom-inventory.mjs
    extract-prototype.mjs
    diff-inventory.mjs
    report-writer.mjs
    label-alias.json
  journeys/
    login-workbench.mjs
    open-project-workspace.mjs
    prototype-parity.mjs
  README.md
```

```bash
# 环境
node cloud-platform/scripts/local-env-reseed.mjs

# server
node cloud-platform/scripts/playwright-server/server.mjs \
  --base https://127.0.0.1:18787 \
  --evidence-dir cloud-platform/evidence/playwright-server

# 探索注入
TOKEN=$(node -p "require('./cloud-platform/evidence/playwright-server/server.json').token")
PORT=$(node -p "require('./cloud-platform/evidence/playwright-server/server.json').port")
curl -s -H "Authorization: Bearer $TOKEN" localhost:$PORT/tabs
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"script":"open-project-workspace","mode":"explore","profile":"zhangsan"}' \
  localhost:$PORT/runs

# 独立回归
node cloud-platform/scripts/playwright-server/journeys/login-workbench.mjs
node cloud-platform/scripts/playwright-server/journeys/open-project-workspace.mjs

# 原型对照
node cloud-platform/scripts/playwright-server/compare-prototype.mjs --all --role admin
```

---

## 11. 设计判定

- **架构一句话**：常驻 Node 进程持有一个 headless Chromium 与按身份隔离的登录上下文，在 127.0.0.1 上以 HTTP/WS 暴露页签、截图、脚本加载与执行能力，探索代理可反复注入脚本，而同一脚本文件也能脱离 server 用 `node` 独立回归。
- **两层脚本**：第一层 `ui` 是 Playwright 的语义薄封装（登录/导航/页签/交互/发现/断言/截图），第二层是真实 `page/locator/frame`；单文件 `defineJourney({run})`，服务模式注入常驻绑定，独立模式由 `runIfMain` 启动临时浏览器调用同一 `run`。
- **原型对照**：用同一个 DOM 清点器分别驱动 `prototype.html` 与实际 Web，产出统一 schema，再按布局（页面/导航/区块/表格列）、字段（label/类型/必填/禁用/选项）、菜单（侧栏/动作/上下文菜单/dialog 按钮）三类归一化 diff，辅以 aria 快照、role/label 试探、并排截图与运行时探针。
- **文档路径**：`remote-connectivity/design/2026-11-13-cloud-dev-platform/work-orders/playwright-server-design.md`。
- **置信度**：高。既有 probe/harness、平台启动方式、Web DOM 与原型结构均已静态核对；剩余不确定性集中在「实际 Web 动态渲染带来的选择器稳定性」与「探索脚本是否需要子进程硬隔离」，两者均已在设计中留出明确升级路径。


## 主会话审定（2026-11-15）

全盘采纳：①常驻 Node 进程+headless Chromium+身份隔离上下文（admin/zhangsan/lisi）+127.0.0.1 HTTP/WS 端口协议；②defineJourney 单文件双模式（server 注入常驻 page/ui ∥ runIfMain 临时 Chromium 独立回归）——两种模式同一脚本正文；③原型对照=同一 DOM 清点器双轮（prototype.html file:// + 实际页，admin/developer 两轮含隐藏层）+三类差异检测（布局 LCS/字段 Dice+别名表/菜单 label+role）+6 条可预见差异作验收自检；④与 tests/e2e spec 不迁移、server 服务探索与快速回归；⑤升级路径（isolate:true+launchServer/connect）留档。实现切分按设计 §切分节（PS 系令），四路探索回收后并行派发。
