# M120 设计方案 · 管理台 Web 呈现补齐（项目登记弹层 / 权限矩阵 / 项目级下载策略）

> 状态：设计稿，待主会话审定后派实现代理（本令只设计不实现，不改任何代码）
> 日期：2026-11-14 · 依据：work-orders-2026-11-14.md「M120」节（QA-013/014/015）· requirements.md FR-3.1 / FR-9.3 / FR-9.4（FR-7.1 二期部分除外）· test-reports/exploratory-qa-web.md §M116-QA-013/014/015
> 现状基线：`cloud-platform/apps/web/app.js`（W3c「打开=进入项目」已提交 085599b77c9 后的形态）· `cloud-platform/apps/api/src/server.ts`（HEAD）
> 风格口径：docs/STYLEGUIDE.md **不适用**——cloud-platform 是独立管理台，遵循 `apps/web` 既有惯例（原生 DOM 字符串模板 + `esc()` + 既有 CSS 类，不引框架不加依赖）

---

## 0. 结论摘要

| 项                   | 缺口                                                  | 接口结论                                                                                                                                                             | 改动域                                      |
| -------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| M120a 项目登记弹层   | QA-013：管理台只能 CLI/API 登记（FR-3.1 P0）          | **现有端点即可**（`POST /v1/projects` + `GET /v1/hosts`），零字段变更                                                                                                | 仅 `apps/web/app.js`（+e2e）                |
| M120b 权限矩阵可配置 | QA-014：矩阵只读、固定五权限、无保存语义（FR-9.3 P0） | **现有端点即可**（`GET/PUT /v1/projects/{id}/grants`），零字段变更                                                                                                   | 仅 `apps/web/app.js`（+e2e）                |
| M120c 项目级下载策略 | QA-015：仅全局二态，无项目覆盖与影响数（FR-9.4 P0）   | **需最小契约补齐**：`projectView` 增 1 个读字段 `downloadPolicyExplicit`；`PUT /v1/projects/{id}/policy` 增 1 个可选写参 `inherit`。均为**加性可选**，线兼容（§5.2） | `server.ts`（c1，约 25 行）+ `app.js`（c2） |

三项目标端点/粒度全部沿用既有语义，不新增端点、不改既有字段含义。M120c 的两个字段是全 M120 唯一的线变更，且对旧对端透明（旧 Web 控制台忽略未知字段；旧客户端从不发送 `inherit`）。

UX 口径对齐 Q1–Q3 裁定先例（PROGRESS.md:2782）：**UX 从简、供面最小化**——单一入口、单一控件、复用既有弹层/表格/按钮样式，不新增导航项、不做向导式分步、不做在线会话实时列表（无端点，§8）。

---

## 1. 背景与缺口

- **QA-013**：admin 登录后侧栏/工作台/我的项目均为只读列表，无任何登记入口；「新建项目弹层（含空值、重复 Key、超长校验）」不存在。FR-3.1（P0）。
- **QA-014**：成员与权限页矩阵为静态 ✓/—，每行只有「移除」；「授予基础权限」固定写死 `open/terminal/agent/file:read/file:write` 五项（`app.js:648`），`download` 列显示锁、`browser` 列**根本不存在**；无法只给 `file:read` 或单独开终端；无保存/重置语义。FR-9.3（P0）。
- **QA-015**：平台设置仅 deny/allow 单选 + toast，无项目级覆盖、无生效范围/影响项目数；「审批」态与「客户端最低版本」副标题所宣称的设置不存在。FR-9.4（P0；「审批后允许」属 FR-7.1 二期，**本令不做**）。

权限全集以契约为准（`packages/contract/src/credential.ts:11`）：`open / terminal / agent / file:read / file:write / browser / download` 共 7 位；导出类方法同时受 `download` 权限位**与**项目级 `downloadPolicy` 双门控制（`packages/contract/src/permissions.ts:67-69`，`EXPORT_DENIED`）。这是 M120b 与 M120c 交界的既有事实：勾了 `download` 而策略为 deny，导出仍被拒。

---

## 2. 复用资产清单（Reuse Before Reimplementing）

| 资产                                                  | 位置                                                                                                         | M120 用法                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `dialog(title, html, actions)` 弹层                   | `app.js:840-864`（action `onClick` 返回 `false` 不关闭）                                                     | M120a 登记弹层、M120b 保存确认                                               |
| `.field/.input/.select/.btn/.table-wrap/.note/.badge` | `styles.css`（`.field:100`、`.select:547`、`.dialog:630`、`.table-wrap:527`）                                | 表单与覆盖表全部复用，新增 CSS ≤1 个类（如 `.form-grid` 两列布局），可零新增 |
| `toast(text)`                                         | `app.js:73-79`                                                                                               | 成功/失败反馈（沿用「已授予/保存失败：…」文案格式）                          |
| `isAdmin()` 门控                                      | `app.js:95-97`                                                                                               | 登记入口仅 admin 可见                                                        |
| `loadContent()` 错误态+重试                           | `app.js:122-137`                                                                                             | 不动；弹层内错误走字段级行                                                   |
| 错误码→提示管线                                       | `api()` 抛出 `err.code/err.message`（`app.js:56-63`）                                                        | 服务端中文 message 直接展示，code 用于字段定位                               |
| e2e 页面探针                                          | `cloud-platform/test/e2e/web-console-page.ts`（happy-dom 加载真实 index.html+app.js，`fail()/stub/calls()`） | 三项 Web e2e 全部复用；平台侧行沿用 `spawnService`（PORT=0 自起，不抢端口）  |
| 审计筛选下拉                                          | `app.js:702-712`                                                                                             | M120a 顺带补 `project_create` 选项（`policy_update` 已存在，M120c 零改动）   |
| W2 既有回归                                           | `web-exploratory-fixes.e2e.test.ts`（QA-009 策略失败回滚、W2-M-1 授予失败不误刷新）                          | M120b/c 的负向断言必须保持这些既有用例全绿                                   |

---

## 3. M120a · 项目登记弹层（QA-013）

### 3.1 入口与可见性

- 「我的项目」page-head（`app.js:380`「刷新」按钮旁）新增 `<button class="btn primary" id="registerProjectBtn">登记项目</button>`，**仅 `isAdmin()` 渲染**。单一入口：工作台不放（供面最小化；工作台已有「查看全部」去我的项目）。
- 开发者不可见（与 `web-admin-gating` 同口径）；即使绕过 UI 直调 `POST /v1/projects`，服务端 403 `PERMISSION_DENIED` + denied 审计（`server.ts:1378-1389`，既有，不加断言重复覆盖，套件里带一条即可）。
- 与自助建项目（`POST /v1/projects/self`）的关系：**管理台一律走管理员路由**。两者不可混用（表内对齐 W8 裁定）：

|      | 管理员 `POST /v1/projects`                                                  | 自助 `POST /v1/projects/self`                                                                              |
| ---- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 路径 | 管理员给**绝对 `path`**（W8：缺 `dir` 不报 INVALID_DIR，path 直供语义保留） | 平台按 `projectsRoot + dir` 推导，**传 `path` 反而 400 `PROJECT_PATH_FORBIDDEN`**（`server.ts:1488-1490`） |
| 主机 | 必填 `hostId`（不校验在线，§8 开放问题）                                    | 可缺省自动选；多台可选时 409 `HOST_REQUIRED`                                                               |
| 授权 | 创建后不授任何人（呈现为「管理员可见（未授权）」，QA-010 口径）             | 创建即给创建者五权限（`server.ts:1577-1583`）                                                              |
| 限额 | 无                                                                          | 20 个（`PROJECT_LIMIT_REACHED`）                                                                           |

弹层表单**不发 `dir`**（管理员路由会忽略它并因缺 `path` 报 400 `PROJECT_PATH_INVALID`）。

### 3.2 字段清单与校验

弹层复用 `dialog()`，body 为表单；「登记」作为 dialog action，校验失败 `return false` 保持弹层开启、输入不丢。

| 字段                     | 控件                                     | 必填 | 客户端校验（先拦，不发请求，对齐 QA-012 先例）                                        | 服务端裁决（权威）                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------- | ---- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目名称 `name`          | `.field` text                            | 是   | 非空、≤200                                                                            | 无校验（缺省取 key）——**客户端必填**                                                                                                                                                                |
| 项目 Key `key`           | `.field` text                            | 是   | `^[a-z0-9][a-z0-9._-]*$`、1–64、不以 `.` 结尾（与 `project-key.ts` 同规则），失焦即校 | 仅查重：409 **`PROJECT_EXISTS`**（注意：管理员路由的重复 Key 码是 `PROJECT_EXISTS`，不是自助路由的 `PROJECT_KEY_TAKEN`；`server.ts:1396-1398`）。服务端**不校验语法**（§8）                         |
| 目标主机 `hostId`        | `.select`（`GET /v1/hosts`，admin-only） | 是   | 必选；已吊销（`revokedAt`）主机不进下拉；选项后缀「（离线）/（维护中）」              | 400 `HOST_NOT_FOUND`                                                                                                                                                                                |
| 目标路径 `path`          | `.field` text                            | 是   | 软校验：绝对路径、无 `..`、不以分隔符结尾（提示语用服务端同款文案）                   | 400 `PROJECT_PATH_INVALID`（`project-path.ts` 细分：空/控制字符/相对路径/`.`·`..`/空段/POSIX 混反斜杠/尾分隔符）；409 `PROJECT_PATH_TAKEN`（同主机同路径，`project-occupancy.ts:20`，归档项目不占） |
| 仓库地址 `repoUrl`       | `.field` text                            | 否   | 空 = 不克隆、登记即就绪                                                               | 400 `REPO_URL_INVALID`（`-` 开头 / `ext::` / 控制字符 / >4096，`repo-url.ts`）                                                                                                                      |
| 默认分支 `defaultBranch` | `.field` text                            | 否   | 空 = 远端默认分支                                                                     | 400 `BRANCH_INVALID`（`branch-name.ts`）                                                                                                                                                            |

辅助呈现（只读提示，不加控件）：选中主机带 `projectsRoot` 时，路径输入下方显示「主机项目根：`<projectsRoot>`」muted 提示，引导登记在根内（数据来自 `GET /v1/hosts` 的完整 host 对象，`server.ts:1990-1997`）。

**不进表单的字段**：`downloadPolicy`（创建后由 M120c 配置；即使不传，服务端也存 `deny` 但不置 explicit，生效值=全局默认，语义无损）；FR-3.1 的「负责人组/可见组」（见 3.4）。

### 3.3 提交流与错误映射

```
点击「登记」→ 客户端必填/格式校验（失败：字段级 inline error + focus 首个错字段，0 请求）
  → POST /v1/projects {name, key, hostId, path, repoUrl?, defaultBranch?}
  → 201：toast「项目已登记」（repoUrl 非空追加「克隆中，就绪后可打开」）→ 关弹层 → 重新拉取列表
  → 4xx/5xx：按 err.code 定位字段，弹层不关、输入保留
```

| 错误码                                                         | HTTP | 字段定位                       | 呈现                                                                                         |
| -------------------------------------------------------------- | ---- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `HOST_NOT_FOUND`                                               | 400  | hostId                         | 服务端 message（正常操作不可达，兜底）                                                       |
| `PROJECT_EXISTS`                                               | 409  | key                            | 「项目 Key 已存在。」                                                                        |
| `PROJECT_PATH_TAKEN`                                           | 409  | path                           | 「该主机目录下已存在同路径的项目。」                                                         |
| `PROJECT_PATH_INVALID` / `REPO_URL_INVALID` / `BRANCH_INVALID` | 400  | path / repoUrl / defaultBranch | 服务端细分中文 message 原样展示                                                              |
| `PERMISSION_DENIED`                                            | 403  | 弹层顶部错误行                 | 非 admin 会话兜底                                                                            |
| `AUDIT_CHAIN_BROKEN` / `AUDIT_UNAVAILABLE`                     | 503  | 弹层顶部错误行                 | 「审计日志不可写…」——写前审计 fail-closed（`server.ts:412-430`），项目未创建，弹层保持可重试 |
| 网络失败 / 非 JSON                                             | —    | 弹层顶部错误行                 | `err.message` 兜底（沿用 `api()` 管线）                                                      |

### 3.4 与 FR-3.1 的差距（如实声明）

FR-3.1 列「负责人组、可见组」，但 `POST /v1/projects` **不接受任何授权字段**，授权只能建后经 `PUT /v1/projects/{id}/grants` 写入（既有端点）。本设计**不在创建弹层做授权**：成功 toast 提示「授权请在『成员与权限』中配置」，AC-04（登记→授权→组内成员可见）由 M120b 的矩阵完成，两步即可走通，且避免弹层里再嵌一层主体/权限选择（供面最小化）。若主会话要求表单内直接带「负责人组」，属 M120a 追加项：成功后对 201 返回的项目补一次 `PUT /grants`（现有端点，两请求非原子，失败时 toast 指引去矩阵补授）——建议不做，留作开放问题。

### 3.5 组件改动点

- `app.js`：新增 `registerProjectDialog()`（约 90–110 行，含字段级 `showFieldError` 小工具）；`renderProjects()` page-head 增按钮与 `isAdmin()` 门控；审计下拉选项数组补 `'project_create'`。无 CSS 新增（或 ≤1 个 `.form-grid`）。
- 审计可见性：`project_create` 事件由服务端既有写入（成功含 `key/path`，拒绝含 `reason`，`server.ts:1400-1427、1442-1458`），Web 侧仅补筛选选项，零接口改动。
- 不动：`renderWorkbench`、项目行双入口（W3/W3c 布局）、`POST /v1/projects` 服务端代码。

---

## 4. M120b · 权限矩阵可配置（QA-014）

### 4.1 交互模型

`showGrants()`（`app.js:601-676`）重写渲染层，页面结构与左侧项目列表不变：

- **列**：主体 / 类型 / `open` / `terminal` / `agent` / `file:read` / `file:write` / `browser` / `download` / 操作。**7 个权限位全部可勾选**（新增 `browser` 列——既有 Permission 集合就有、QA-014 指出的缺失；`download` 列由锁改为复选框）。
- 行内复选框 = 本地草稿（`draft: Map<rowKey, Permission[]>`，`rowKey = subjectType + ':' + subjectId`），脏行加 `.dirty` 视觉标记；未保存不落盘。
- 页脚：「保存变更」（有脏行才可点）+「放弃修改」（重绘回服务端状态）。
- `download` 列旁 note 文案更新为真话：「`download` 仅在项目下载策略为『允许』时生效（平台设置）；策略为『禁止』时勾选也不放行导出。」——替换现行已失真的「一期固定为禁止，审批流二期开放」（`app.js:627`）。
- 客户端白名单：仅提交 7 个合法位（服务端对 `permissions` 数组**不校验**、原样入库，`server.ts:1737-1739`；杂串只是永不匹配的哑权限）。
- 「已删除用户」死行（W2 m-2 遗留）保持只读 + 移除禁用，不在本令解锁（需服务端支持，挂账 M120 清理令之外，见 §8）。

### 4.2 保存语义：项目级增量 diff，行内全量替换

- **端点粒度不变**：`PUT /v1/projects/{id}/grants` 一次一个主体、`permissions` 为该主体全量数组（服务端先删该主体旧行再按数组重建，`server.ts:1770-1783`）。
- **保存 = diff 后逐脏行 PUT**：只对草稿 ≠ 服务端值的行发请求；未变更行零请求。顺序执行，**首个失败即停**：toast「已保存 N 项，M 项失败：<主体>」，随后 `GET /grants` 重绘（已应用的行保持，未应用的行回到服务端值；每次 PUT 幂等，重试安全）。
- 选「增量 diff + 保存按钮」而非「勾选即存」的两个理由：① QA-014 的期望明写「可编辑矩阵并保存」，缺少保存/重置语义本身就是缺口；② 每次 grant 变更都有**撤销连带效应**（4.3），diff 把一次多勾选合并为一次撤销，而不是勾一下断一次会话。
- 行内 `移除` 保持现状（立即 `PUT permissions: []` + 失败 toast，W2-M-1 行为），不并入暂存模型——移除的后果自明（行消失）、已有错误处理，最小改动。备选（移除也暂存）已否：多一套「待删除」状态机，收益仅是延迟一次撤销。
- 新增授权：保留主体输入 + 类型下拉，按钮改「添加授权」，创建即带 `['open']`（服务端空数组=删除该主体授权，新行必须 ≥1 位），随后在矩阵中勾选调整。**一个控件取代现行写死五权限的「授予基础权限」按钮**（减供面）。`USER_NOT_FOUND` → toast + 输入保留（W2-M-1 回归语义不变）。

### 4.3 撤销时在线会话处置的呈现（如实，无实时会话端点）

平台没有「项目在线会话列表」端点（`store.sessions` 仅内部使用），控制台**无法点名列出谁在线**，因此呈现为**保存确认中的规则性提示**（`dialog()` 二次确认）：

- 用户行变更 → 「保存将断开 **<username>** 当前全部云会话（含其他项目）。」——`PUT` 用户行触发 `revokeUserCredentials(username)`（`server.ts:1787-1789`），宿主按票据 `sub` 匹配、跨项目生效（`src/main/cloud-platform/cloud-admission-ledger.ts:65-77`）。
- 组行变更 → 「宿主无法解析组成员，保存将断开 **该项目** 当前全部在线会话。」——触发 `revokeProjectCredentials(projectId)`（AC-12 语义，`cloud-grant-revocation-scope.test.ts` 既有实证：用户行变更不断开他人）。
- 确认框列出差量摘要（+新增位 / −移除位 按主体分行），取消则不落盘。断开后用户重新打开项目即按新权限重签凭证，无需额外提示。

### 4.4 组件改动点与错误处理

- `app.js`：`showGrants()` 渲染层 + `draft` 状态 + diff/保存/确认（约 120–150 行）；CSS 复用复选框原生渲染（`.table-wrap` 内），新增 ≤1 个 `.dirty` 高亮类。
- 错误处理矩阵：单行 PUT 失败 → 中止 + toast（含失败主体）+ 重绘；`USER_NOT_FOUND`（新增授权）→ toast；确认框取消 → 不落盘，草稿保留待修订（「放弃修改」才回服务端值）；批量期间「保存变更」禁用防双击。
- 审计：`grant_update` 既有写入（含 `subjectType/subjectId/permissions`，`server.ts:1753-1769`），审计页筛选已含该事件，零改动。

---

## 5. M120c · 项目级下载策略（QA-015）

### 5.1 接口现状与缺口（如实指出）

已存在且直接可用：`GET/PUT /v1/policies/download`（全局默认，`server.ts:2400-2457`）、`GET/PUT /v1/projects/{id}/policy`（项目覆盖，`server.ts:1886-1953`，PUT 置 `downloadPolicyExplicit=true`）、`/v1/internal/policy` 已把 explicit 覆盖下发给宿主（`server.ts:2512-2516`）。

**真实缺口有两个**：

1. **读不出「谁在覆盖」**：`projectView` 只回**原始存储值** `downloadPolicy`（`server.ts:734`），管理员创建/自助项目缺省都存 `deny`，全局默认改 `allow` 后这些项目实际生效 `allow`，控制台却无法区分「显式覆盖」与「跟随全局」——既列不出覆盖清单，也算不出 FR-9.4 要求的「影响项目数」。现行工作台「禁用下载项目」统计与项目卡「下载已禁用」徽标（`app.js:179、263、403`）正是拿原始值当生效值，全局 `allow` 时**误报**。
2. **清不掉覆盖**：`PUT /policy` 永远置 `downloadPolicyExplicit=true`，没有「跟随全局」写法。语义差异真实存在：显式覆盖钉死的项目在全局默认日后翻转时不受影响，UI 必须能表达并撤销钉住。

### 5.2 最小契约与线兼容性（全 M120 唯一线变更）

| 变更   | 契约                                                                                                                                                                                    | 兼容性                                                                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 读字段 | `projectView` 增 `downloadPolicyExplicit: boolean`（`p.downloadPolicyExplicit === true`，加性可选字段）                                                                                 | 新字段对旧对端透明：旧 Web 控制台不读、桌面客户端忽略未知字段（AGENTS「新可选字段安全」）。生效值仍由控制台自行推导：`explicit ? downloadPolicy : 全局默认`（工作台本就拉了 `/v1/policies/download`），不另发 `downloadEffective` 字段（可推导的不上 wire） |
| 写参数 | `PUT /v1/projects/{id}/policy` 接受可选 `inherit: true`：清 `downloadPolicyExplicit`（`delete`），忽略 `downloadPolicy`；`readRatePerHour` 语义不动。审计 metadata 增 `inherited: true` | 旧客户端从不发送该参数（现被忽略），行为零变化；响应体形状不变；`/v1/internal/policy` 的 `projectOverrides` 随之自然收敛（宿主按继承走全局，正是期望）。服务端对未知字段本就不校验，无解码破坏面                                                            |

不新增端点、不改既有参数含义、不动 `denyPrivileged`/审计门（PUT 仍 admin-only + denied 审计，`server.ts:1902-1909`，回归保护）。

### 5.3 UI（平台设置页）与生效范围 / 影响项目数

`renderSettings()`（`app.js:784-820`）在全局卡片下新增「项目级覆盖」卡片：

- **统计行（FR-9.4 的生效范围）**：`跟随全局默认 N 个项目 · 独立覆盖 M 个项目`（N/M 来自 `GET /v1/projects`（admin，非归档）+ 新字段推导；全局保存成功的 toast 追加「30 秒内生效；跟随全局 N 个项目，独立覆盖 M 个不受影响」）。
- **覆盖表**：仅列 explicit 项目——项目名 / 当前覆盖（`.select`：`禁止`/`允许`/`跟随全局`）/ 操作。M=0 时显示 muted「暂无项目覆盖，全部项目跟随全局默认。」（不做全项目大表：几百行不可维护，且非覆盖项无事可编辑）。
- 行内选择即保存（与全局卡「保存」按钮的既有形态一致的最小粒度）：`禁止/允许` → `PUT {downloadPolicy}`；`跟随全局` → `PUT {inherit:true}`。失败沿用 QA-009 模式：toast「保存失败：…」+ 立即按服务端值重绘回滚，绝不留下显示与实际不符的行。
- **审计可见性**：`policy_update` 事件既有（项目级含 `targetType:'project'` + `metadata.downloadPolicy`，全局含 `targetType:'policy'`），审计页筛选下拉已含该事件——M120c 零改动，仅 e2e 断言覆盖。

### 5.4 顺带修正（随 c2，一行级）

- 工作台统计卡「禁用下载项目」、项目卡徽标、「我的项目」表格「下载策略」列统一改用推导后的生效值（修 §5.1-1 的误报）。
- 设置页副标题「下载策略与客户端最低版本。」→「下载策略：全局默认与项目覆盖。」（QA-015 指出副标题宣称不存在的设置；「客户端最低版本」能力本身不在本令范围）。

---

## 6. 测试设计（e2e 断言清单）

层一沿用既有双轨：Web 探针（happy-dom 真实 index.html+app.js + 真实平台进程，`PORT=0` 自起）+ 平台 API e2e；证据入 `cloud-platform/evidence/m120{a,b,c1,c2}-*/`。所有用例必须保持 `web-exploratory-fixes.e2e.test.ts`（QA-009/W2-M-1）与 `web-admin-gating.e2e.test.ts` 全绿。

**M120a**（新 `web-project-registration.e2e.test.ts`）：

1. admin 见「登记项目」，developer 不见（gating 口径同 AC-18）；developer 直调 `POST /v1/projects` → 403 + denied 审计。
2. 空值/非法 Key（大写、`..`、超 64）提交 → **0 请求**（`calls()` 断言无 `POST /v1/projects`）+ 字段级错误。
3. 真实平台登记成功（无 repoUrl）→ 201、toast、列表出现新行、状态可打开；带 repoUrl → 「克隆中」提示且 `status=provisioning`。
4. 重复 Key → 409 `PROJECT_EXISTS` 落在 key 字段、弹层不关、输入保留。
5. 重复路径 → 409 `PROJECT_PATH_TAKEN` 落在 path 字段；相对路径 → 400 `PROJECT_PATH_INVALID` 落在 path 字段。
6. 审计：`project_create` 成功事件存在；审计筛选下拉含 `project_create` 且按其过滤非空。

**M120b**（新 `web-permission-matrix.e2e.test.ts`）：

1. 矩阵渲染 7 个权限列复选框，初值与 `GET /grants` 一致；`browser` 列存在。
2. 勾选变更后未保存 → 无 `PUT`；点「保存变更」→ 确认框文案含「断开 … 全部云会话」（用户行）/「断开该项目 … 在线会话」（组行）→ 确认后**仅脏行**各一次 `PUT`，body 为该行全量数组（未勾的位不丢）。
3. 保存后 `GET` 重绘与服务端一致、脏标记清除；`GET` 调用次数断言无多余刷新。
4. `fail('PUT', grantsPath)` 中途失败 → 中止 + toast 含失败主体 + 重绘为服务端状态、无 unhandled rejection（W2-M-1 口径延续）。
5. 新增授权：不存在用户 → 400 `USER_NOT_FOUND` toast、矩阵不变（回归）；存在用户 → 新行默认含 `open` 且可改勾。
6. `download`/`browser` 勾选可保存并被服务端回读；宿主侧会话断开语义不在 Web 套件重复断言（`cloud-grant-revocation-scope.test.ts` 已有真实链路覆盖）。

**M120c1**（新 `project-download-policy.e2e.test.ts`，平台侧）：

1. `PUT {downloadPolicy:'allow'}` → `GET /policy` 返回 `effective='allow'` 且 `projectView.downloadPolicyExplicit === true`。
2. `PUT {inherit:true}` → `GET /policy` `effective === globalDefault`、`downloadPolicyExplicit === false`；`/v1/internal/policy` 的 `projectOverrides` 不再含该项目。
3. 非 admin `PUT` → 403 + denied 审计（既有语义回归）；不带 `inherit` 的旧形态请求行为逐字节不变（老客户端回归断言）。

**M120c2**（新 `web-download-policy.e2e.test.ts`）：

1. 零覆盖 → 「暂无项目覆盖」+ N/M 统计正确；造一个覆盖后表行出现、M 增 1。
2. 覆盖行选「跟随全局」→ 发出 `PUT {inherit:true}` → 行消失、统计更新。
3. 全局保存成功 toast 含「跟随全局 N 个项目」字样（FR-9.4 影响项目数）。
4. `fail('PUT', '/v1/projects/:id/policy')` → 行回滚 + toast（QA-009 模式回归）。
5. 工作台徽标：全局 `allow` + 项目无覆盖 → 「允许下载」；有显式 `deny` 覆盖 → 「下载已禁用」（修正 §5.1-1 误报的正反两例）。

---

## 7. 实施切分（每代理 ≤15 分钟口径，通道①内严格串行）

| 令     | 内容                                                               | 域             | 预估                                                                             | 提交信息                                                        | 证据                            |
| ------ | ------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------- |
| M120a  | 登记弹层 + 入口 + 审计下拉补项（§3）+ e2e 6 条                     | 仅 `app.js`    | 15–20 分钟（若超时：e2e 4–6 负向三条拆给测试代理单独成令 M120a-e2e）             | `feat(web): admin project registration dialog`                  | `evidence/m120a-registration/`  |
| M120b  | 矩阵可编辑 + diff 保存 + 撤销确认（§4）+ e2e 6 条                  | 仅 `app.js`    | ≈20 分钟（超时切分：M120b1 编辑+保存+正向 1–3/5–6；M120b2 中途失败与确认负向 4） | `feat(web): editable project permission matrix`                 | `evidence/m120b-matrix/`        |
| M120c1 | `downloadPolicyExplicit` 读字段 + `inherit` 写参（§5.2）+ e2e 3 条 | 仅 `server.ts` | ≈10 分钟                                                                         | `feat(cloud): explicit download policy flag and inherit option` | `evidence/m120c1-policy-field/` |
| M120c2 | 设置页覆盖卡 + 统计 + 徽标修正 + 副标题（§5.3–5.4）+ e2e 5 条      | 仅 `app.js`    | ≈15 分钟                                                                         | `feat(web): per-project download policy overrides`              | `evidence/m120c2-policy-ui/`    |

顺序 **a → b → c1 → c2**（c2 消费 c1 字段，必须在其后）。并发护栏：a/b/c2 全改 `apps/web/app.js`、c1 改通道①热点 `server.ts`，四令**同一通道串行**，不得与通道③的 app.js 任务（W7b/W3c 后续）并行派发。每令走三权分立（实现 → 独立测试 → 只读审计），三方齐备主会话才关闭。

---

## 8. 风险与开放问题（请主会话裁定）

- **R1 服务端对管理员登记的 key/name 不设防**：`POST /v1/projects` 不跑 `validateProjectKey`、空 key 可入库（`server.ts:1395`）；本设计以客户端校验补位，**不改服务端**——硬化会让既有 CLI/脚本的旧 key 形态开始 400，属行为变更，需单独裁定（建议后续小令 + 契约测试）。
- **R2 管理员登记不校验主机在线/路径存在**（FR-3.2 字面）：在线校验仅 UI 软提示；「路径存在或可克隆」由既有 provisioning 回报闭环（`status: provisioning → ready/failed` + `provisioningError`，`server.ts:746-782`），登记弹层不做存在性预检（无宿主探测端点，不新增）。
- **R3 FR-3.1「负责人组/可见组」进不进创建表单**：建议不进（§3.4），如需进则 M120a 追加一次 `PUT /grants` 后置调用，非原子，失败须有指引。
- **R4 W13-Q3 遗留复审**（PROGRESS.md:2782「宿主侧 worktree.list 过滤不做，随 M120 复审」）：该项属**宿主行为变更**，与管理台呈现补齐不同域，本设计维持「不做」，建议保持独立开放问题、不并入 M120a–c。
- **R5 挂账边界**：W2-m2（死用户行可移除，需服务端）、grant 403 的服务端 denied 审计缺失（m-1）、web-handoff 限流/抽文件（W7a minor）均**不在本设计范围**，仍走各自清理令，防止实现代理漂移。
- **R6 `download` 双门语义**：勾选 `download` 但项目策略为 deny 时导出仍拒（既有 `EXPORT_DENIED`）。M120b 的 note 文案已写明；若主会话希望矩阵在 deny 项目上把 `download` 列置灰，属一个 `disabled` 属性的小追加，建议 c2 顺带评估而非 b 承担。

## 9. 不做清单（明确范围外）

「审批后允许」三态（FR-7.1 二期）；客户端最低版本设置；通知面板（QA-030）；弹层焦点陷阱/Esc 关闭（QA-016，P2）；在线会话实时列表（无端点）；宿主侧 worktree.list 过滤（R4）；自助建项目 UI（属桌面客户端 FR-3.7，已有）。
