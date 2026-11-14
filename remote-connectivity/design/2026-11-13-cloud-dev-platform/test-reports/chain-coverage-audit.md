# 链路覆盖自查审计：业务链路 vs 实际自动化（2026-11-14）

> 触发：用户实测「管理控制台进入项目工作区」不通（宿主对云会话方法裸 `forbidden`），而同期所有工作令测试全绿。
> 方法：只读核对。以 `business-chain-tests.md` 四条链路 34 个步骤为基准，逐步骤核对
> ①是否存在真实组件参与的自动化测试、②最近一次真实执行的证据时间戳、③失败/变更时是否会被静默放过。
> 快照：HEAD `acf35ea10bb`（2026-11-14 ~11:00）。注意：审计期间工作区有 W5b 在途改动（`cloud-platform/`、`src/` 大量未提交修改），
> 涉及「W5b 是否已修」的表述以当时在途状态为准，结论不受影响。

## 0. 结论速览

- **34 步中 9 步标红**（从未被真实执行或仅 mock 层覆盖）：B2、B3、B4、B6、C4(表单)、C5(矩阵)、C6(项目级)、C10、D6；
  另有 **W9 双黄金旅程（A 线/B 线）从未执行**（无 spec、无 evidence 目录）。
- **用户实测断裂的那一步（管理台/浏览器 → 工作区）确实是零真实覆盖**：全部「绿」来自三条相互叠加的盲区（§4）。
- 分段测试没有撒谎，但它们**测的不是同一条链**：桌面链（A）有真实组件测试；
  浏览器链（B/C10）的「真实组件」测试用的是**与生产不同的宿主方法表**，且只断言恰好落在 mobile 允许清单里的方法。

---

## 1. 真实度分级

| 级别 | 含义 |
| --- | --- |
| **R1** | 真实平台进程 + 真实 Orca 宿主（真实 TLS/E2EE/方法表/PTY），真实客户端（Electron 或浏览器模块）驱动 |
| **R2** | 真实平台进程 + HTTP/DOM 层（happy-dom 跑真实 app.js / fetch 级）；宿主为 `runtime-sim` 或仅是注册行，无真实宿主参与 |
| **R3** | 组件级 mock（scripted host、mock bridge、mock xterm） |
| **R0** | 无自动化测试 |

## 2. 步骤 × 测试存在性 × 最近执行 × 真实度 矩阵

最近执行时间 = `cloud-platform/evidence/<module>/` 内最新文件的 mtime（gitignored，本地为准）。

### 链路 A · 桌面客户端

| # | 步骤 | 测试（文件） | 真实度 | 最近真实执行 | 静默跳过风险 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | 零 env 启动登录 | `src/main/cloud-platform/cloud-login-memory.test.ts`、`cloud-session-login-address.test.ts`、`config/scripts/electron-vite-cloud-define-coverage.test.ts` | R2/R3 + 一次性真实启动脚本 | `evidence/w10-fix-verify/` 11-14 09:33（真实 Electron 零 env 启动） | 启动级验证是一次性脚本（`journey-a.mjs`）**未沉淀为常驻测试**，回归靠单测 | 🟡 |
| A2 | 域账号登录 | `platform.e2e.test.ts` E1、`m70-acceptance`、`m97-workbench-latency`、`tests/e2e/cloud-native-first-paint.spec.ts`（真实 Electron 客户端+宿主+平台） | R1+R2 | E1 11-14 10:33；m107 11-13 22:27 | 无 skipIf；真实 Electron 线 24h 未重跑 | 🟢 |
| A3 | 打开项目（直连/回落） | `src/main/cloud-platform/cloud-connect-client.test.ts`（真实平台+真实宿主+TLS+E2EE+RPC）、E1/E2、m101 | R1+R2 | 11-14 10:33（E1/E2）；connect-client 随 vitest 全量 | 无 | 🟢 |
| A4 | 终端输入/回显 | `cloud-terminal-echo-latency.test.ts` m102（真实中继+TLS+E2EE+**真 PTY+真 shell**，50 采样+延迟对照）；UI 层 `cloud-project-workspace-terminal.test.tsx` 为 R3 | R1（传输级）/ R3（UI 级） | **m102 最后 11-13 21:09**（今日 8 波提交前） | 测试重（真 PTY+采样），代理倾向「focused 跑」→ 易被整日跳过 | 🟡 |
| A5 | 文件树/打开文件 | `cloud-file-listing-latency.test.ts` m103（真实链路）+ m29/m36/m41 边界 | R1+R2 | **m103 最后 11-13 21:09** | 同上 | 🟡 |
| A6 | 断开重连/会话恢复 | `cloud-session-restart.test.ts`、`web-cloud-session-restore.e2e.test.ts`（真实平台+宿主） | R1+R2 | 11-14 10:31 | 无 | 🟢 |
| A7 | 自助新建项目 | `self-service-project-dir.e2e.test.ts` + `cloud-create-failure.test.ts` | R2 | 11-14 10:33 | 无 | 🟢 |
| A8 | 全程审计留痕 | m31/m8/m89（真实平台+审计 writer） | R2 | 11-14 10:33 | 无 | 🟢 |

### 链路 B · Orca Web（浏览器第二形态）

| # | 步骤 | 测试（文件） | 真实度 | 最近真实执行 | 静默跳过风险 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | 登录平台 Web + 入口可见 | `web-exploratory-fixes.e2e.test.ts`、`web-admin-gating.e2e.test.ts`（happy-dom 跑真实 app.js → 真实平台） | R2 | 11-14 10:33/10:34 | 无；但**非真浏览器**（无 CSP/CORS/cookie 真实行为） | 🟢(R2) |
| B2 | 点「Orca Web」→ 一次性 handoff → 新标签打开 web-index | 平台端点 `web-handoff.e2e.test.ts`（真实平台，9 例）；控制台按钮 `web-handoff-entry.e2e.test.ts`（happy-dom `button.click()`，`window.open` 非真导航） | R2（端点）/ R3（「新标签打开」） | 11-14 10:33–10:37 | DOM shim 里 `window.open` 不产生真实标签/加载 | 🔴（UI 半边仅 mock） |
| B3 | 自动进入该项目工作区 | `src/renderer/src/web/web-cloud-handoff-entry.e2e.test.ts`（真实平台+真实 TLS 宿主+真实浏览器模块，断言 `entered`+`status.get`） | R1**但方法表缩水**（见 §4-①） | 11-14 10:37 | 只断言 `status.get`；**工作区打开 RPC 族（`project.provision`/`worktree.list`）从未被断言** → 与生产宿主组合从未测过 | 🔴 |
| B4 | 终端输入/回显、文件树（浏览器侧对等 A4/A5） | `cloud-terminal-panel.test.tsx`（**scripted host**，自述「真 PTY 在 M118 e2e（W5b）验证」）；W5b 真宿主+真 PTY e2e **今日仍在修，未合入** | R3 | 组件测试随全量；真宿主版不存在 | mock 断言与宿主真实回执可无限期背离 | 🔴🔴（本次事故核心） |
| B5 | code 失效/重放 410 | `web-handoff.e2e.test.ts` + `w7b-2-replay-410.json` | R2+R1 | 11-14 10:33/10:37 | 无 | 🟢 |
| B6 | 经中继浏览器入口 `/h/<routeKey>/` | `relay-browser-mode.e2e.test.ts`（真实平台+**真实中继**+`relay-target-host.ts` **25 行 echo 替身**）；`relay-browser-entry.e2e.test.ts`（仅平台 payload）；`w6c` 构建层 | R2（宿主为替身） | 11-14 10:33 | 替身宿主永远「转发正确」；真实宿主经中继的浏览器全链无人测过 | 🔴 |
| B7 | 关浏览器重开会话恢复 | `web-cloud-session-renewal.e2e.test.ts`(M62)、`web-cloud-session-restore.e2e.test.ts`(M66 web 侧)（真实平台+宿主，localStorage 模块级） | R1(模块级) | 11-14 10:31 | 非真浏览器（无真实 reload/存储分区语义） | 🟡 |
| B8 | 同浏览器第二个项目互不影响 | 桌面 M53（11-13 19:37）；web 侧 M54 双项目（见 C10） | R1(缩水表) | M53 11-13；M54 11-14 10:44 | M54 用缩水方法表 | 🟡 |

### 链路 C · 管理员

| # | 步骤 | 测试（文件） | 真实度 | 最近真实执行 | 静默跳过风险 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 登录管理台 | `web-admin-gating.e2e.test.ts` | R2 | 11-14 10:34 | 无 | 🟢 |
| C2 | 添加中继 | `relay-endpoint-address.e2e.test.ts`（真实平台+真实中继） | R2 | 11-14 10:33 | 无 | 🟢 |
| C3 | 添加开发机 | M107（真实 Electron 宿主+客户端+平台）、`install-wizard.e2e.test.ts` | R1+R2 | m107 11-13 22:27 | 真实跨机安装属 D6 | 🟢 |
| C4 | 项目登记 | API：`m95`/platform.e2e ✅；**Web 表单：R0（M120 未做）** | R0 | — | 文档已登记缺口 | 🔴（表单） |
| C5 | 授权 | 组 ✅ m95/m96；用户级 ✅ `user-grant-resolution.e2e.test.ts`（11-14 10:34）；**权限矩阵 R0（M120）** | R0（矩阵） | — | 同上 | 🔴（矩阵） |
| C6 | 下载策略 | 全局 ✅ m79（11-14 09:14）；**项目级 R0（M120）** | R0（项目级） | — | 同上 | 🔴（项目级） |
| C7 | 主机管理/巡检 | `host-offline`/`host-revocation`/`m70`/`m74` 等 | R2 | 11-14 10:33 | 无 | 🟢 |
| C8 | 中继页巡检 | `m114-relay-page` | R2 | 11-14 10:33 | 无 | 🟢 |
| C9 | 审计闭环 | m31/m8/m89/m100 | R2 | 11-14 10:33 | 无 | 🟢 |
| C10 | 详情入口 → 会话页工作区 | 入口：`web-project-entry.e2e.test.ts`（R2：payload+按钮矩阵，**页面不加载**）；页面：M54 `cloud-admin-session.e2e.test.ts`（R1 但**缩水方法表**）；真浏览器：`tests/e2e/cloud-native-acceptance-shots.spec.ts`（真实 Chromium→真实宿主 cloud-admin.html，**纯截图、仅 3 个 expect、无终端/工作区断言**） | R2+R1(缩水)+截图 | 截图 **11-14 03:09**（早于今日全部 8 波集成 08:56–10:37）；M54 10:44 | **截图型「验证」失败不红**：forbidden 只会出现在没人看的 PNG 里 | 🔴🔴（用户实测断裂步） |
| C11 | 平台设置 → 客户端生效 | m79 | R2 | 11-14 09:14 | 无 | 🟢 |
| C12 | 管理链全程审计 | AC-13/26 套件 | R2 | 11-14 10:33 | 无 | 🟢 |

### 链路 D · 平台运维

| # | 步骤 | 测试 | 真实度 | 最近真实执行 | 判定 |
| --- | --- | --- | --- | --- | --- |
| D1 | 部署+一行安装脚本 | `install-wizard.e2e.test.ts`（真实平台出脚本+审计；**未在真实机器执行**） | R2 | 11-14 10:33 | 🟡 |
| D2 | TLS 指纹固定 | `cloud-host-tls-pinning.test.ts`（真实平台+真实 TLS 宿主） | R1 | 11-14 00:39 | 🟢 |
| D3 | 中继双模式 | `relay-browser-mode.e2e.test.ts`（真实中继；宿主=echo 替身）+ SNI 回归 | R2 | 11-14 10:33 | 🟡（中继真实/宿主替身） |
| D4 | 容量 300×30min | `test/load/load-300.test.ts`（runtime-sim，无 PTY/逐帧 E2EE） | R2 | 11-14 01:21 | 🟡（PASS(部分)，本机回环） |
| D5 | 审计链篡改检测 | `audit-verify`/`audit-anchor`/m31 | R2 | 11-14 10:33 | 🟢 |
| D6 | 真实跨机链路 | R0（⏸ M114c，仅有方案文档 `deployment-real-link.md`） | R0 | 从未 | 🔴 |

### 黄金旅程（W9）

| 线 | 状态 |
| --- | --- |
| W9a 桌面 A 线（C2/C3/C4(API)/C5 前置 + 打开项目→终端→文件→时间线） | **R0：无 spec、无 `evidence/journey-golden-a/`，从未执行** |
| W9b Orca Web B 线（handoff→自动进工作区→终端/文件→410） | **R0：同上，从未执行** |

`business-chain-tests.md` §6 的「W9 将 A2–A5 串成单测」在当前 HEAD **不成立**（计划排期写的是「W9 移至最后」，即压轴——顺序本身是缺陷，PROGRESS 2026-11-14 已确认并决定提前）。

---

## 3. 红名单（9 步 + 2 旅程）

| 优先 | 红步骤 | 一句话依据 |
| --- | --- | --- |
| 1 | **B4 浏览器侧终端建立** | 唯一覆盖是 scripted-host 组件测试（`cloud-terminal-panel.test.tsx` 自己注明真 PTY 归 W5b）；W5b 真宿主 e2e 在事故后才补 |
| 2 | **C10 管理台详情入口→工作区** | 入口测试只验 payload+按钮；M54 用缩水方法表；真浏览器仅截图无断言，且 03:09 后未再跑 |
| 3 | **B3 handoff 自动进入工作区** | 有真实平台+宿主，但宿主方法表缺 `PROJECT_PROVISION_METHODS`，断言止步 `status.get` → 生产组合从未被测 |
| 4 | **B2 新标签打开 web-index** | happy-dom `window.open` 非真导航；真浏览器从未跑过控制台→Orca Web 按钮 |
| 5 | **B6 经中继浏览器入口** | 「三进程」中的宿主是 25 行 echo 替身（`relay-target-host.ts`）；无浏览器、无 PTY、无 E2EE |
| 6 | **W9a/W9b 双黄金旅程** | 零 spec、零证据，从未执行（原排期压轴） |
| 7 | C4 Web 登记表单 / C5 权限矩阵 / C6 项目级策略 | R0（M120，已登记） |
| 8 | D6 真实跨机链路 | R0（M114c，仅方案） |

---

## 4. 为什么「全绿」却断链（三个叠加机制）

**① 测试宿主的方法表 ≠ 生产宿主的方法表（结构性静默通过）。**
生产云宿主注册 `ALL_RPC_METHODS + MANAGED_WORKTREE_METHODS + PROJECT_PROVISION_METHODS`
（见 `cloud-project-provisioning.test.ts:107` 注释「Production wires this in attachCloudRuntime」）；
`project.provision` 被**刻意**排除在 `ALL_RPC_METHODS` 之外（`src/main/runtime/rpc/methods/project-provision.ts`）。
而全部浏览器侧真实宿主测试（`cloud-admin-session.e2e.test.ts:179`、`web-cloud-session-restore.e2e.test.ts:187`）只装
`ALL + MANAGED_WORKTREE` → `openCloudWorkspaceOverRpc` 的 `project.provision` 走「宿主早于 M57」容错分支照样成功
（`src/shared/cloud-workspace-open.ts:73-82`）。生产宿主上同一调用却命中权限/scope 判定。

**② 浏览器侧测试选的方法恰好都在 mobile 允许清单里。**
scope 判定顺序是「先 mobile 后 cloud」（`src/main/runtime/runtime-rpc/runtime-rpc-websocket-dispatch.ts:85-95`）：
一旦浏览器会话被宿主登记成 `scope:'mobile'`（`device-registry.ts` 默认值），一切方法先过
`MOBILE_RPC_METHOD_ALLOWLIST` 裸拒绝。既有浏览器测试只调 `status.get`、`files.readDir`
（M54、W7b 均是）——这两个方法**恰好也在 mobile 允许清单**里（allowlist 241/44 行），所以全绿；
而工作区打开真正需要的 `project.provision`、`worktree.list`（**不在** allowlist）与 `terminal.*` 的宿主映射从未被断言。
用户看到的正是注释里预言过的形态：`forbidden` + 「is not available to mobile clients」，
不匹配 `cloud-workspace-open.ts:76-80` 容错的「not available to cloud sessions」文案 → 裸 forbidden 透出。

**③ 唯一的真浏览器检查是截图，且先于全部集成波次。**
`cloud-native-acceptance-shots.spec.ts` 用真实 Chromium 打开真实宿主的 `cloud-admin.html`——这本可以是冒烟套件的雏形，
但它只有 3 个 `expect`、零功能断言，最后运行 03:09；今天的 8 波代码提交（08:56–10:37）之后无任何真浏览器→真宿主检查。

放大器：
- **cloud-platform 测试套件没有任何 CI workflow 挂钩**（`.github/workflows/` 无引用），执行完全靠代理自觉；
- **验收索引只验证据文件存在/非空/合法 JSON**（`cloud-platform/test/acceptance-index.test.ts`），不验「测试还在跑、还在同一代码上跑」→ AC 的 PASS 可以无限期陈旧；
- 证据驱动的 AC 索引/指引测试在快照环境**本身会失败**（gitignored evidence 缺失），失败被归类「环境产物」——「红=环境问题」的先例会钝化红信号。

---

## 5. 改进方案

### a) 常驻链路冒烟套件（每波集成后必跑，目标 ≤5 分钟）

**名字**：`tests/e2e/cloud-chain-smoke.spec.ts`（Playwright，electron-headless + chromium 双驱动）。
**原则**：一个平台、一个真宿主、两个入口、四条断言；失败即阻塞合并，不许「环境产物」豁免。

```
启动一次（≈60s）
  platform(spawn apps/api) + 真宿主 OrcaRuntime(production 方法表: ALL+MANAGED_WORKTREE+PROJECT_PROVISION, 真 TLS+真 PTY)
  + 注册主机 + 建项目 + 授权(open/terminal/file:read)

步骤（≈3min）
 S1 桌面客户端(真实 Electron)登录 → 项目行出现 → 打开项目 → 工作区路由徽标
 S2 终端输入 `echo orca-smoke-$RANDOM` → 断言回显含该串（真 PTY 字节，非 mock）
 S3 文件树展开 → 打开 README → 断言内容
 S4 管理台(apps/web, 真实 Chromium)登录 → 项目行「详情」新标签 → cloud-admin.html 工作区建立成功（无 forbidden）
 S5 同一页面终端输入回显 + 文件列表（浏览器侧对等）
 S6 「Orca Web」按钮 → 真实新标签 → handoff 换发 → 自动进工作区 → status.get
 S7 中继浏览器模式（可选常开，+60s）：/h/<routeKey>/ 页面 200 + WSS 建 RPC
收尾
 断言审计事件含 login/open/terminal/web_handoff；输出时间线 JSON 到 evidence/chain-smoke/
```

**关键设计约束**（每条都对应本次事故的一个盲区）：
1. **宿主方法表必须等于生产**（三件套），并在 harness 里加一条守卫断言：`PROJECT_PROVISION_METHODS ⊆ 注册方法集`，防再次缩水；
2. **至少一个断言必须调用 mobile 允许清单之外的方法**（`project.provision` / `worktree.list` / `terminal.create`），因为 scope 误映射只在这些方法上现形；
3. 必须用**真实浏览器**驱动管理台与 web-index（CORS/新标签/hash 消费只有真浏览器是真的）；
4. 全程单一文件、共享一个 stack（`tests/e2e/helpers/cloud-platform-stack.ts` 已有 80% 基建）、`--workers=1`，预算 5 分钟；
5. 挂到 `test:e2e:cloud-chain-smoke` 脚本 + 要求每条 `feat(cloud)`/`fix(cloud)` 提交的工作令在交付说明里附其运行结果（替代缺失的 CI 门禁；CI 就绪后改为必跑）。

### b) 各红步骤最小补测

| 红步骤 | 最小补测 | 预算 |
| --- | --- | --- |
| B4 浏览器终端 | W5b（在途）：真实平台+真 PTY+production 方法表下 `terminal.create`→回显→`terminal.close`，补 `无 terminal 授权 → 占位` 负例 | 已派发，收口即可 |
| C10 详情→工作区 | 把 `cloud-native-acceptance-shots.spec.ts` 的截图段升级为断言版（工作区建立 + 终端回显 + forbidden 时显式 fail），或直接并入冒烟套件 S4/S5 | 0.5 天 |
| B3 handoff 进工作区 | `web-cloud-handoff-entry.e2e.test.ts` 与 `cloud-admin-session.e2e.test.ts` 的宿主改用 production 方法表，断言从 `status.get` 延伸到 `entered.workspacePath` 非空 + `worktree.list` 成功 | 0.5 天 |
| B2 新标签 | 冒烟套件 S6（真 Chromium `window.open` → 新 page → hash 消费） | 含在 a |
| B6 经中继入口 | `relay-browser-mode.e2e.test.ts` 的 `relay-target-host.ts` 替身旁增加一条真宿主变体（真宿主经中继被浏览器访问，断言 RPC 可用） | 1 天 |
| C4/C5矩阵/C6项目级 | 维持 M120，但给 M120 加验收定义：表单/矩阵/策略各自带一条「Web 操作 → 平台状态 → 开发者可见」e2e（R2 即可） | M120 内 |
| D6 跨机 | 维持 M114c，不阻塞本审计 | 环境依赖 |
| W9a/W9b | **立即**按已写好的 `business-chain-tests.md` §1/§2 各落一条连续旅程 spec（W9a 可直接复用冒烟 S1–S3 + 审计断言；W9b 复用 S6 + 410 重放） | 各 0.5 天 |

### c) 测试分层规则修订（建议写入 AGENTS.md「Verifying Changes」或云端工作令纪律）

1. **链路步骤的覆盖依据必须是 R1/R2 级**（真实平台进程，且宿主为真实 Orca runtime 或明示的替身）；**R3（mock/scripted host）测试不得作为任何业务链路步骤「已覆盖」的依据**，只能作为组件回归。文档标注 ✅ 时必须写测试文件路径与真实度级别。
2. **测试环境的组件配置必须钉住生产形态**：宿主方法表、能力位、scope 映射等「生产在 attachCloudRuntime 装配」的东西，harness 必须从同一常量组装，禁止测试内手抄子集；加守卫断言（见 a-1）。
3. **禁止用「恰好能过」的方法代表链路步骤**：一个步骤的自动化断言必须触达该步骤用户可见的结果（工作区路径、终端回显字节、文件内容），不得以 `status.get`/HTTP 200 代替。
4. **截图不构成链路验证**：截图 spec 必须伴随功能断言，或明确标注「仅视觉留档，不作为覆盖依据」。
5. **证据时效**：AC 索引对每条证据记录「产生它的测试文件 + 最近运行时间」；超过 N 个集成波次未重跑的证据自动降级为「陈旧」，不得在验收文档中标 ✅。
6. **红即红**：快照/依赖缺失导致的失败必须当天修复或显式登记为缺口，不得默认归类「环境产物」；`journey-golden` 类压轴排期取消——新形态（B 线）每合入一波，冒烟立即重跑。

---

## 6. 附：证据时间戳基线（审计时点）

| 证据 | 最近执行 | 说明 |
| --- | --- | --- |
| `evidence/w5b-terminal-e2e/` | 11-14 10:46–10:49 | W5b 探针（真实平台+全方法表+真 PTY），在途，`probe1-host-audits.json` 尚为 `[]` |
| `evidence/w7b-handoff-web/` | 11-14 10:33–10:37 | B2/B3/B5/B7 相关 |
| `evidence/m54-admin-session-page/` | 11-14 10:44 | 浏览器桥+真宿主（缩水方法表） |
| `test-reports/screenshots/web|native/` | 11-14 10:33 / 03:09 | 真 Chromium 检查（无断言） |
| `evidence/m102/m103` | **11-13 21:09** | 今日 8 波提交前 |
| `evidence/m107-native-first-paint/` | 11-13 22:27 | 同上 |
| `evidence/journey-golden-*` | 不存在 | W9 未执行 |
