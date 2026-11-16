# U116① / G27 / G06 管理台统一设计

> 状态：设计稿（只读代码后产出，未改实现）
> 日期：2026-11-16
> 范围：`cloud-platform/apps/web`（管理台）+ `cloud-platform/apps/api/src/server.ts`（仅 G06 一处读放宽）
> 原则：优先复用既有端点、既有 `app.js` 交互模式；接口加性优先；不做服务端 ack；归档是“移出在营视图”，不是删除。

---

## 0. 结论摘要

| 项 | 结论 | 是否改后端 |
|---|---|---|
| U116① 归档/恢复 UI | 复用 `POST /v1/projects/:id/archive|restore`，在列表行、归档分组行、详情页脚提供入口；确认用既有 `dialog()`；权限按需求只给 admin 展示；归档后移入独立分组，恢复后按 `repoUrl` 进入 provisioning 或 ready | 否 |
| G27 全量项目策略 | 设置页从“只列显式覆盖”改为“列出全部在营项目 + 三态选择（跟随全局/禁止/允许）”；行内保存携带 `expectedVersion`；409 行级保留选择并提供刷新重试；不做同步 ack | 否（端点已支持） |
| G06 归档只读可见 | 列表用既有 `?includeArchived=1`（admin）；详情新增同一参数的 opt-in 只读返回，默认 404 不变；详情隐藏写入面；工作区/策略/授权仍不可用 | 是，1 处守卫 + 测试 |

**统一交互基调**：在营列表保持原样；归档是“历史区”，必须与在营区视觉和语义上都隔离；任何会把归档项目当活项目处理的入口（打开工作区、改策略、改授权）一律禁用并说明原因。

---

## 1. 现状与可复用基线

### 1.1 服务端已有的能力（本轮不重复造）

- 项目列表：`GET /v1/projects` 默认排除 archived；`?includeArchived=1` 仅 admin 生效（`apps/api/src/server.ts:2386-2403`）。
- 归档/恢复：`POST /v1/projects/:id/archive|restore`，admin 或项目创建者可调用；archive 幂等、写 `project_archive`、释放 key/path、写项目撤销；restore 做 key/path 冲突检查、写 `project_restore`（`server.ts:2934-3020`）。
- 恢复状态机：`found.status = found.repoUrl ? 'provisioning' : 'ready'`，清 `provisioningError`，重新占用 key（`server.ts:3018-3021`）。
- 项目级策略：`GET/PUT /v1/projects/:id/policy`；PUT 支持 `inherit:true` 与 `expectedVersion`，版本是全局共享的 `store.policies.version`；冲突返回 409 `POLICY_VERSION_CONFLICT` + `details.version/downloadPolicy`（`server.ts:3024-3149`）。
- 审计事件目录已含 `project_archive` / `project_restore`（`apps/api/src/audit-event-catalog.ts:39,43`），管理台审计筛选中已有中文标签（`apps/web/app.js:2878,2882`）。

### 1.2 管理台既有模式（必须复用）

| 模式 | 位置 | 复用方式 |
|---|---|---|
| `dialog(title, html, actions, options)`，`danger` 按钮 | `app.js:3577-3643` | 归档/恢复确认弹框；Esc/遮罩/关闭按钮统一行为 |
| `toast()` | `app.js:101` | 所有保存/归档/恢复结果 |
| `openDisabledReason()` 单一因由 | `app.js:659-668` | 统一“不可打开”的 title；补充 provisioning/failed |
| `projectStatusBadge` / `PROJECT_STATUS` | `app.js:1198-1210` | 归档/准备中/失败徽标 |
| 列表行 + 移动卡片双渲染 | `app.js:657-760`，`styles.css:1258-1470` | 桌面表格与 ≤700 卡片保持同数据、同操作 |
| 行内保存 + 滚动/焦点保留 + 失败回滚 | `app.js:3520-3545` | G27 行级策略保存 |
| `effectiveDownloadPolicy` / `downloadPolicyExplicit` | `app.js:552-558` | 生效值与“覆盖/跟随”来源判断 |
| 全局策略冲突卡 | `app.js:3392-3410` | G27 行级冲突复用同一套“刷新后重试”，只把提示挂到行内 |
| 移动端全屏 sheet | `styles.css:1460-1510` | 归档详情在手机上仍是 sheet |
| 审计标签映射 | `app.js:2845-2885` | 归档/恢复事件无需新增前端标签 |

### 1.3 Orca 与业界参照

- Orca 桌面端已把归档能力封装为 `archiveProject`（`src/renderer/src/cloud/cloud-workspace-entry.tsx:253-271`、`src/main/cloud-platform/cloud-connect-client.ts:231-244`）：归档成功后清理运行时环境/侧栏行。控制台只做平台侧同义操作，不复制桌面端清理逻辑。
- GitHub archived repository：归档后只读、从活跃列表分离、提供 Unarchive；Linear：归档分组 + 恢复；企业控制台（Stripe/AWS/Google Admin）：策略三态必须显式给出“继承/覆盖”而不是靠空值猜测，乐观并发冲突要保留用户选择并重试。本设计与这三条一致。

### 1.4 现状缺口（本设计要解决的）

1. 归档/恢复没有管理台入口；`apps/web` 仅能通过 API 或桌面端触发。
2. `renderSettings` 只列 `downloadPolicyExplicit === true` 的项目（`app.js:3385-3388`），跟随全局的项目没有行，导致**无法从 UI 新建覆盖**（既有缺陷 WEB-R2-009）。
3. `GET /v1/projects/:id` 对 archived 一律 404（`server.ts:2722-2725`），归档项目在管理台只能看列表一行，无法看详情。
4. `openDisabledReason` 不检查 `provisioning/failed`，恢复后的项目可能显示“打开”可用但服务端 409。
5. `web-exploratory-fixes` R5-② 与 `web-download-policy` M120c2 系列固化了旧语义，必须随本设计更新（见 §5）。

---

## 2. U116① 归档 / 恢复控制台 UI

### 2.1 需求原文

> 管理台项目列表/详情提供归档与恢复操作；归档项目在列表中如何分组/过滤；恢复后状态机（archived→provisioning→ready）；权限（admin）；审计事件；确认弹框文案。

### 2.2 真实用户意图

- 管理员要能**在管理台完成完整生命周期**：发现问题项目 → 归档使其退出在营范围 → 需要时恢复，而不是切到 API/桌面端。
- “归档”是**可逆的隔离**，不是删除；确认文案必须回答“数据会不会没、还能不能回来、谁会受影响”。
- 恢复不是瞬时可用：带仓库的项目要重新准备，管理员需要看到 `准备中` 并知道为什么还不能打开。
- 归档项目不能继续产生可操作入口，否则管理员会误点、误改策略、误开工作区。

### 2.3 方案

#### 2.3.1 入口

| 位置 | 在营项目（admin） | 已归档项目（admin） |
|---|---|---|
| 列表行（桌面表格） | `详情` 后增加 `归档`（`.btn.sm.btn.danger`） | `恢复`（`.btn.sm`），无 `打开` |
| 移动卡片操作区 | `详情`、`归档`、`打开工作区`（打开仍受门禁） | `详情`、`恢复` |
| 详情页脚 | 主按钮 `打开项目`（受门禁）+ `归档项目`（danger） | 主按钮 `恢复项目`（primary），不出现 `打开项目` |
| 工作台 | **不增加**任何归档入口，仍只展示在营项目 | 不展示 |

> 列表行已有 4 个操作（打开/自助授权/详情/Orca Web），再增加 danger 按钮需要保持间距；移动端卡片用 `plc-spacer` 把 `打开工作区` 推到右侧，`归档` 放左侧操作簇。若后续操作继续膨胀，再引入统一的 `⋯` 菜单（不在本期）。

#### 2.3.2 权限

- 管理台 UI 以 `isAdmin()` 为唯一可见条件：非 admin 不渲染 `归档/恢复`，也不请求 `includeArchived=1`。
- 服务端现有“创建者可归档自己的项目”语义**保持不变**（`server.ts:2935-2939`）；本期不把它暴露到控制台（否则与“权限 admin”的验收原文冲突）。见 T1/Q1。
- 归档/恢复请求不新增权限位；失败 403/404 按现有错误码处理。

#### 2.3.3 列表分组与过滤

桌面：

- `全部状态`：在营表格原样；其下若 admin 且存在归档项目，渲染独立分组 `<details class="archived-group">`，`<summary>已归档项目（N）</summary>`，默认折叠。
- `仅在线` / `仅离线`：只作用于在营项目，归档分组隐藏。
- `已归档（N）`（仅 admin 且 N>0）：主表格只渲染归档项目；不显示在营表格。
- 搜索框同时匹配两组（名称/repoUrl/hostName）；分组计数是过滤后的数量。
- 归档分组内的行与在营表格同列结构，但状态列显示 `已归档` 徽标，操作列只有 `详情`、`恢复`。

移动（≤700px）：

- 表格隐藏的既有策略不变；在营卡片列表后渲染 `<details class="archived-group">`，内部用同一 `projectListCard` 渲染归档卡片（徽标 + `恢复`）。
- chips 横向滚动，新增 `已归档 N`；触控高度 44px。

> **对 U53③ 的解释**：U53③ 要求归档项目不进入“工作台/我的项目”的**在营视图**。本设计把归档放进独立、默认折叠、仅 admin 可见的“历史分组”，不参与在营计数、在营筛选、在营排序；工作台完全不加载。该解释需在 T2 明确并更新旧测试。

#### 2.3.4 恢复状态机（按服务端真实行为）

```
archived
  │ POST /restore
  ├─ 409 PROJECT_KEY_TAKEN / PROJECT_PATH_TAKEN → 保持 archived（不改本地状态）
  └─ 200
       ├─ repoUrl 非空 → provisioning ──(宿主心跳 provision ok)──> ready
       │                                  └─(provision fail)─────> failed
       └─ repoUrl 为空 → ready（立即可打开）
```

- 需求原文写作 `archived→provisioning→ready`；服务端实际是“有仓库才 provisioning，无仓库直接 ready”（`server.ts:3018-3021`）。UI 文案按这个事实写，不承诺固定经过 provisioning。见 T4。
- 恢复成功后列表刷新：项目回到在营区，状态徽标为 `准备中`/`就绪`/`准备失败`。
- `准备中`、`准备失败` 时 `打开` 必须禁用并给因由（`项目准备中，暂时无法打开` / `项目准备失败`），避免点击后才 409。见 T5。

#### 2.3.5 审计

- 归档成功：服务端已写 `project_archive`（actor=操作者、target=project、metadata.selfService）。
- 恢复成功：`project_restore`；冲突失败：`project_restore` + `result=failure` + `reason=PROJECT_KEY_TAKEN|PROJECT_PATH_TAKEN`。
- UI **不额外写审计**，只在 toast 中展示结果。验收时以 `/v1/audit/events` 过滤 `project_archive`/`project_restore` 断言。

### 2.4 接口 / 字段

复用，无新增：

| 调用 | 请求 | 成功 | 失败 |
|---|---|---|---|
| 归档 | `POST /v1/projects/{id}/archive`，无 body | 200 `projectView`（`status=archived`），幂等 | 404 `PROJECT_NOT_FOUND`（无权限/不存在）；503（审计不可写） |
| 恢复 | `POST /v1/projects/{id}/restore`，无 body | 200 `projectView`（`status=provisioning|ready`） | 404；409 `PROJECT_KEY_TAKEN`/`PROJECT_PATH_TAKEN` |
| 列表 | `GET /v1/projects?includeArchived=1`（仅 admin） | `{projects:[...]}` 含 archived | 401/403 |

字段使用：`id/name/key/repoUrl/hostId/hostName/hostStatus/path/defaultBranch/status/permissions/downloadPolicy/downloadPolicyExplicit/createdBy/createdAt`，全部既有。

### 2.5 UI 状态图

```
[在营行/详情]
  idle ──点击归档──> confirm(archive)
                        ├─ 取消 → idle（0 请求）
                        └─ 确认 → archiving (按钮 disabled, 文案“归档中…”)
                                    ├─ 200 → 关闭弹框/刷新 → 行移入已归档组；toast 已归档
                                    ├─ 404 → toast 失败 + 刷新列表（竞态）
                                    └─ 网络/503 → toast 失败；行保持，弹框保持可重试

[已归档组行/详情]
  idle ──点击恢复──> confirm(restore)
                        ├─ 取消 → idle
                        └─ 确认 → restoring
                                    ├─ 200 → 刷新 → 行移入在营区；toast
                                    │        └─ 有仓库：status=provisioning（打开禁用）
                                    │        └─ 无仓库：status=ready
                                    ├─ 409 → 详情内联错误（Key/路径被占用），保持 archived
                                    └─ 网络 → toast；保持 archived
```

### 2.6 确认弹框文案（逐字）

归档：

- 标题：`归档项目「{name}」？`
- 正文：
  - 归档后，该项目将从工作台和项目列表中移出，只保留在管理台的「已归档」分组。
  - 该项目当前的云端工作区会话会被断开。
  - 主机磁盘上的项目目录与代码不会被删除。
  - 项目 Key 与路径会被释放，可能被新项目复用；恢复时若已被占用，将无法恢复。
  - 之后可由管理员在「已归档」中恢复。
- 按钮：`取消` / `归档项目`（danger，默认焦点在取消更安全；实现时把 `取消` 作为第一个可聚焦按钮）。

恢复：

- 标题：`恢复项目「{name}」？`
- 正文：
  - 恢复后项目重新进入在营列表。
  - 配置了仓库的项目会先进入「准备中」，等待主机下次心跳准备，完成后才能打开。
  - 若项目 Key 或路径已被其他在营项目占用，恢复会失败，项目保持归档。
- 按钮：`取消` / `恢复项目`（primary）。

> 使用 `dialog()` 而不是 `window.confirm`：多行后果说明需要可读排版，且危险按钮需要 `.btn.danger`。`confirmDialog()` 仅保留给单句确认。

### 2.7 错误与空态

| 场景 | UI |
|---|---|
| 归档 404 | toast `归档失败：项目不存在或无权访问。`，刷新列表；不本地改状态 |
| 归档 503/网络 | toast `归档失败：{message}`；弹框保留，可重试 |
| 恢复 409 KEY | 详情内联 `项目 Key 已被占用，无法恢复。请先处理同名在营项目。`；列表保持已归档 |
| 恢复 409 PATH | 详情内联 `项目路径已被占用，无法恢复。请先处理同路径在营项目。` |
| 恢复 404 | toast；刷新列表 |
| 归档分组为空 | 不渲染分组；`已归档` chip 也不渲染 |
| 过滤后为空 | 在营表格既有“没有匹配的项目”；归档过滤时 `暂无归档项目` |
| 列表加载失败 | 沿用 `loadContent` 的失败态与重试 |
| 恢复后 provisioning 失败 | 在营行/详情显示 `准备失败` + `provisioningError`；打开禁用 |

### 2.8 移动端

- 归档/恢复确认弹框：≤700px 用既有 `.dialog` 全宽（非 sheet；确认不需要全屏历史栈）。
- 详情仍用全屏 sheet；页脚按钮 sticky，`归档项目`/`恢复项目` 与 `关闭` 均为 44px 高。
- 卡片操作区：`归档` 使用 `btn sm danger` 但手机 `min-height:44px`；`恢复` 同。
- 归档分组 `<summary>` 触控高度 ≥44px，展开后卡片单列。
- 所有文案不依赖 hover；错误用内联文本 + toast 双通道。

### 2.9 测试点（含验收断言）

新增 `cloud-platform/test/e2e/web-project-archive.e2e.test.ts`：

1. **权限**：admin 在营行有 `归档`；developer 无 `归档/恢复`，且页面从不请求 `includeArchived=1`。
2. **归档确认**：点击 `归档` 出现标题/5 条后果文案；取消后 `POST .../archive` 调用数为 0；确认后恰好 1 次；行移入 `已归档项目（1）`，在营表格不再有该行；toast 含 `已归档`。
3. **幂等/竞态**：外部已归档后再次确认，UI 收到 200 后仍只显示一次归档行；404 时 toast + 刷新，不出现幽灵行。
4. **恢复**：归档行点 `恢复` → 确认 → 恰好 1 次 `POST .../restore`；有 repoUrl 的项目回到在营区且状态 `准备中`、`打开` disabled title=`项目准备中，暂时无法打开`；无 repoUrl 项目直接 `就绪`。
5. **恢复冲突**：服务端 409 `PROJECT_KEY_TAKEN` 时，详情内联文案命中“Key 已被占用”，项目仍在归档组，列表无在营副本。
6. **审计**：归档/恢复各产生 1 条 `project_archive`/`project_restore`，actor 为 admin，targetId 正确；恢复冲突产生 `project_restore` failure。
7. **分组/过滤**：`全部状态` 显示在营 + 折叠归档组；`已归档` 只显示归档；`仅在线` 隐藏归档组；搜索命中归档名称时分组计数为 1。
8. **工作台隔离**：工作台请求不含 `includeArchived`，不出现归档项目。
9. **状态门禁**：`provisioning`/`failed` 行与详情打开按钮均禁用，title 与 `openDisabledReason` 同源。

性能/回归断言：管理台项目页对 `GET /v1/projects?includeArchived=1` 只发 1 次；归档后刷新不重复请求。

---

## 3. G27 设置页全量项目策略

### 3.1 需求原文

> 列出全部在营项目的策略行（跟随全局/禁止/允许），走 `PUT /v1/projects/:id/policy`（已支持 expectedVersion）；与全局策略卡的关系；移动端形态；同步状态文案（不做服务端 ack）。

### 3.2 真实用户意图

- 管理员要在一个页面回答两个问题：**全局默认是什么**、**哪些项目被钉住、各自生效什么**。
- 当前只有“覆盖清单”，导致“想给一个跟随全局的项目加覆盖”无路可走（WEB-R2-009）。全量列表让策略从“例外清单”变成“项目策略总览”。
- 三态必须显式：`跟随全局` 不是一个空值，而是可以选择、可以回退的目标；当显式值与全局当前值相同时，仍要标明“这是覆盖，不是继承”。
- 保存冲突不能静默覆盖：共享版本下，别的管理员刚改过全局/别的项目时，必须保留本行选择并让管理员刷新重试。
- “同步”只发生在主机心跳；控制台不能假装知道主机已生效。

### 3.3 方案

#### 3.3.1 页面结构（替换现有“项目级覆盖”卡）

```
平台设置
├─ 全局下载策略（原卡不动）
│   ├─ 禁止下载 / 允许下载 单选
│   ├─ 当前版本 vN
│   └─ 保存（携带 expectedVersion）
└─ 项目下载策略（原“项目级覆盖”卡升级）
    ├─ 说明：列表覆盖全部在营项目；跟随全局的项目无需单独保存
    ├─ 统计：全部 N · 跟随全局 X · 独立覆盖 Y
    ├─ 提示：策略保存后随宿主下一次心跳生效；本页不轮询主机确认，也不显示“已同步”
    └─ 表格（桌面）/ 卡片（≤700）
        ├─ 项目（名称 + 路径 + 来源徽标）
        ├─ 策略（select：跟随全局/禁止/允许）
        └─ 当前生效（禁止/允许 + 来源）
```

- 范围：`projects.filter(p => p.status !== 'archived')`。归档项目不参与策略，也不在此页提供恢复入口（恢复入口在项目页）。见 T6/Q8。
- 数据来源：一次 `GET /v1/projects`（live）+ 一次 `GET /v1/policies/download`，**不逐项目 GET /policy**，避免 N+1。
- 行内 `select` 值：`p.downloadPolicyExplicit === true ? p.downloadPolicy : 'inherit'`。
- 选项文案：
  - `跟随全局（当前：禁止/允许）`
  - `禁止下载`
  - `允许下载`
- 来源徽标：`跟随全局` / `独立覆盖`；显式值与全局当前值相同时额外显示 `独立覆盖（与全局相同）`，避免“看起来像继承”。
- `当前生效`：`effectiveDownloadPolicy(p, globalDefault)`。

#### 3.3.2 与全局策略卡的关系

- 全局保存后整页重绘：所有 `跟随全局` 行的 `当前生效` 随全局变化；所有 `独立覆盖` 行保持不变。统计行同步更新。
- 全局卡的成功 toast 继续说明影响面：`已保存，将随宿主心跳生效；跟随全局 X 个项目，独立覆盖 Y 个不受影响`（保留既有文案，不出现“30 秒”）。
- 项目行保存成功后更新本地 `policy.version = saved.version`，再重绘；这样后续行保存用新版本。
- 项目行的“跟随全局”是写操作（`PUT {inherit:true}`），不是本地清空；保存后行仍保留（G27 全量列表），来源徽标变回 `跟随全局`。

#### 3.3.3 行内保存与冲突

- 每次 change 立即保存，发：
  - 禁止/允许：`{ downloadPolicy: 'deny'|'allow', expectedVersion: policy.version }`
  - 跟随全局：`{ inherit: true, expectedVersion: policy.version }`
- 保存中：该行 select `disabled`，行尾显示 `保存中…`；其他行可继续操作（但共享版本会让并发保存串行冲突，服务端会 409，UI 按冲突处理）。
- 成功：`policy.version = saved.version`；toast `已保存项目下载策略` / `已恢复跟随全局默认`；重绘并保留 scrollTop + 焦点（复用 `app.js:3520-3545`）。
- 409 `POLICY_VERSION_CONFLICT`：
  - **不覆盖用户选择**；行内显示 `策略已被他人修改（服务端 vN）。你的选择「禁止/允许/跟随全局」尚未保存。` + `刷新后重试`。
  - 重试：重新 `GET /v1/policies/download` 拿新版本，再按记住的选择重放；同时重读项目列表，确保来源/生效值是最新的。
- 400 `POLICY_INVALID` / 403 / 网络：toast `保存失败：{message}`，整页按服务端值重绘回滚（沿用 M116-QA-009 规则）。

#### 3.3.4 同步状态文案（不做 ack）

统一文案：

- 页面常驻说明：`策略保存后随宿主下一次心跳生效；本页不轮询主机确认，也不显示“已同步”。`
- 成功 toast：`已保存项目下载策略，将随宿主心跳生效`（不带秒数）。
- 禁止出现：`30 秒内生效`、`已同步`、`主机已确认`、绿色同步状态点。
- 不写 localStorage 的“待同步”标记：刷新后无法判断主机是否已拉取，持久标记会变成假事实。见 T8/Q9。

### 3.4 接口 / 字段

无新增端点、无新增字段：

| 调用 | 用途 | 关键字段 |
|---|---|---|
| `GET /v1/projects` | 全量在营项目 + 来源 | `downloadPolicy`、`downloadPolicyExplicit`、`status` |
| `GET /v1/policies/download` | 全局值 + 共享版本 | `downloadDefault`、`version` |
| `PUT /v1/projects/:id/policy` | 行内三态保存 | body `downloadPolicy` 或 `inherit:true`，加 `expectedVersion`；响应 `downloadPolicy/version` |

兼容性：`expectedVersion` 与 `inherit` 都是既有可选参数（U136④a / M120c1）；老服务端忽略未知字段或按 LWW 处理，新 UI 不会发送新结构。

### 3.5 UI 状态图

```
renderSettings
  ├─ loading → 渲染（一次取数）
  └─ ready
       ├─ 全局卡 idle ──保存──> savingGlobal
       │                         ├─ 200 → 重绘；version=saved.version
       │                         ├─ 409 → 全局冲突卡（既有）
       │                         └─ 失败 → toast + 重绘回滚
       └─ 行 idle ──select change──> savingRow(该行 disabled)
                                     ├─ 200 → version=saved.version；toast；重绘（保留 scroll/焦点）
                                     ├─ 409 → rowConflict（保留选择；显示服务端版本；刷新后重试）
                                     ├─ 400/403/网络 → toast + 重绘回滚
                                     └─ 重试 → 重读版本/列表 → 重放选择
```

### 3.6 错误与空态

| 场景 | UI |
|---|---|
| 没有在营项目 | 卡片空态：`当前没有在营项目，暂无项目级策略可设置。` |
| 全部跟随全局 | 统计 `跟随全局 N · 独立覆盖 0`；表格仍列出所有行（这是 G27 与旧版最大差异） |
| 全局未加载 | 沿用 `loadContent` 失败态，不渲染半页 |
| 行 409 | 行内冲突文案 + `刷新后重试`；选择不丢 |
| 行 400/网络 | toast + 重绘回滚；不保留假值 |
| 非 admin 直达设置 | 既有 forbidden 视图；不发任何策略请求 |
| 归档项目 | 不出现在列表；说明中注明“归档项目不参与策略，恢复后重新进入本列表” |

### 3.7 移动端

- ≤700px 用卡片列表，每卡：项目名 + 路径 + 来源徽标；`select` 全宽、`min-height:44px`、16px 字号（避免 iOS 聚焦放大）；`当前生效` 独立一行。
- 统计行在卡片上方，允许换行；长项目名截断但 `title` 保留全名。
- 保存中/冲突提示放在卡片内，不依赖横向滚动。
- 全局策略卡在项目列表之前；两块均单列。
- 不改变移动端底栏；设置仍在“更多”入口。

### 3.8 测试点（含验收断言）

更新 `web-download-policy.e2e.test.ts` 的 M120c2-1/2/3/7（旧断言“只列 explicit”必须改为“全量在营项目”），新增断言：

1. **全量行**：3 个 live 项目（1 个显式拒绝、1 个显式允许、1 个跟随全局）全部出现；归档项目不出现；`overrideSelects(page).length === 3`。
2. **三态映射**：跟随全局行 value=`inherit` 且选项文案含当前全局值；显式行 value 为 `deny/allow`，来源徽标 `独立覆盖`；显式值等于全局时显示“与全局相同”。
3. **新建覆盖（WEB-R2-009 回归）**：对跟随全局行选 `允许` → 恰好 1 次 `PUT /v1/projects/{id}/policy`，body `{downloadPolicy:'allow', expectedVersion: v}`；服务端 `downloadPolicyExplicit=true`；行来源变 `独立覆盖`。
4. **回退继承**：显式行选 `跟随全局` → body `{inherit:true, expectedVersion:v}`；行仍在列表，来源变 `跟随全局`，`当前生效` 回落全局。
5. **全局联动**：全局从 deny 翻到 allow 后重绘：跟随行生效变允许，独立覆盖行不变；统计数字正确；toast 不含“30 秒”。
6. **409 行级冲突**：stub 409 `details {version, downloadPolicy}` → 该行选择保持、行内出现“策略已被他人修改”+服务端版本；`刷新后重试` 重读版本后重放成功；其他行不受影响。
7. **失败回滚**：stub 500/网络 → toast 含“保存失败”，行按服务端值重绘。
8. **滚动/焦点**：连续改两行后 scrollTop 与焦点保留（沿用 M120c2-7 模式，数量断言改为全量行）。
9. **文案事实性**：页面文本不含 `30 秒`/`已同步`/`主机已确认`；包含“随宿主心跳生效；本页不轮询主机确认”。
10. **权限**：developer 设置路由 forbidden，页面无项目策略表，`PUT` 调用数 0。

---

## 4. G06 归档项目可见性（只读）

### 4.1 需求原文

> 归档项目在管理台只读可见（列表归档分组 + 详情可看，不允许打开工作区/改策略）；后端 `GET /v1/projects/:id` 对 archived 的 404 是否放开为只读返回（wire 兼容评估）。

### 4.2 真实用户意图

- 归档后仍要能**查账**：确认它属于哪个主机/路径/仓库、谁创建的、当时的策略与授权摘要，而不必先恢复。
- “可见”不等于“可操作”：详情必须一眼看出这是历史项目，所有写入口和打开入口都不可用。
- 不能因为开放详情而让旧客户端/旧页面把归档项目当活项目。

### 4.3 后端方案：opt-in 只读返回（推荐）

**不**无条件把 archived 的 GET 改成 200。采用与列表一致的显式参数：

```
GET /v1/projects/{id}?includeArchived=1
```

规则（仅 admin）：

| 请求者 / 参数 | 在营项目 | 归档项目 |
|---|---|---|
| admin，无参数 | 200 | **404（不变）** |
| admin，`includeArchived=1` | 200（参数无副作用） | **200 只读 projectView** |
| 非 admin（含创建者、auditor），任意参数 | 既有权限语义 | **404（不变）** |
| 未知 id | 404 | 404 |

实现点：`server.ts:2720-2726` 的 archived 守卫改为
`if (found.status === 'archived' && !archiveAction && !archivedReadOptIn) return 404`，
其中 `archivedReadOptIn = req.method === 'GET' && action === '' && isAdmin(authed.user) && url.searchParams.get('includeArchived') === '1'`。

保持不变（必须逐条断言）：

- `PUT /v1/projects/:id` archived → 404（`server.ts:2744-2747`）。
- `GET/PUT /v1/projects/:id/policy` archived → 404（早于 arch 守卫的统一 404）。
- `GET/PUT /v1/projects/:id/grants` archived → 404。
- `POST /v1/projects/:id/connect`、`web-handoff`、工作区取票 → 拒绝（`visibleProject` 已排除 archived，`server.ts:1702-1707`；handoff 另有 `project_archived` 分支）。
- `GET /v1/projects` 默认仍排除 archived；`includeArchived=1` 仍仅 admin。

#### 4.3.1 为什么不无条件放开

- 旧客户端把详情 404 当作“项目已不可用”的既有信号；无条件 200 会改变**所有**调用者的默认语义。
- opt-in 与列表参数同名同权限，调用方意图明确；旧客户端不传参数，行为逐字不变。
- 未来若有其他只读消费者（审计导出、运营后台），可复用同一参数，不需要再改默认。

#### 4.3.2 Wire 兼容矩阵

| 客户端 \ 服务端 | 旧服务端（无 opt-in） | 新服务端（本设计） |
|---|---|---|
| 旧客户端（web/桌面/脚本） | 现状：详情 404；列表默认不含 | **不变**：详情无参数仍 404；列表默认不含；响应字段零变化 |
| 新控制台 | 归档详情 404 → 显示“当前平台版本不支持归档详情”并保留列表摘要；归档/恢复仍可用（M65 端点已在旧服务端） | 200 `projectView`，`status=archived`，其余字段与在营同构 |
| 新控制台，非 admin | —— | 404，不泄露存在性 |

结论：**无新增字段、无新 opcode、无版本号变更**；只是同一 GET 上的参数语义扩展，属于加性兼容。唯一的行为变化对“显式传参的 admin”生效。见 T3/T9。

### 4.4 前端方案

#### 4.4.1 数据层

- `state` 增加 `archivedProjects: []`（仅 admin 的项目页填充）。
- `loadProjects({ includeArchived = false } = {})`：
  - 请求 `/v1/projects` 或 `/v1/projects?includeArchived=1`；
  - `state.projects = body.projects.filter(p => p.status !== 'archived')`；
  - `state.archivedProjects = includeArchived ? body.projects.filter(p => p.status === 'archived') : []`；
  - 返回值保持为 live 数组，避免改动工作台/设置页所有调用点。
- `renderProjects` 对 admin 调 `loadProjects({includeArchived:true})`；工作台、设置页保持默认。
- `openRouteDetail` / `applyRoute` 的“项目存在”判断改为 `[...state.projects, ...state.archivedProjects]`，支持 `#/projects/:id` 直达归档详情。
- 退出登录/切换账号时清空 `archivedProjects`（沿用现有 state 重置路径）。

#### 4.4.2 详情只读形态

- 顶部 `note` 横幅：`该项目已归档，仅供查看；不能打开工作区、修改策略或授权。`
- 页脚：只保留 `恢复项目`（primary）与 `关闭`；不渲染 `打开项目`；若平台不支持 opt-in（404），页脚只有 `关闭`。
- 权限 tab：归档时隐藏，信息页的“直接授权”显示 `归档项目不参与授权变更`；“下载策略”仍用项目行 + 全局默认渲染（不请求 archived 的 `/policy`）。
- 刷新请求：
  - `GET /v1/projects/{id}?includeArchived=1`（404 时 `refreshFailed` 文案改为“当前平台版本不支持归档详情”）。
  - 不请求 `/grants`、`/hosts/{id}/grants`；`/v1/policies/download` 仍可取（全局默认）。
- 详情内的策略行只读：不渲染“改策略”入口（本详情本来没有策略编辑，策略编辑在设置页；设置页不列归档，已双保险）。
- `openDisabledReason` 对 archived 的既有因由 `项目已归档，无法打开` 保留；详情不显示打开按钮。

#### 4.4.3 列表

- 归档分组与 U116① 共用实现（§2.3.3），不另做一套。
- 归档行徽标 `已归档`、状态列 `已归档`、操作 `详情/恢复`；下载策略徽标仍按项目行显示（只读信息，不是可编辑入口）。

### 4.5 接口 / 字段

| 变化 | 类型 | 说明 |
|---|---|---|
| `GET /v1/projects/:id?includeArchived=1` | 行为加性 | admin + archived → 200；无参数默认 404 不变 |
| 响应字段 | 无变化 | 继续用 `projectView`，`status:'archived'` 已存在 |
| 错误码 | 无变化 | 404 `PROJECT_NOT_FOUND` 仍是默认与非 admin 的唯一答案 |

不新增 `archivedAt/archivedBy`：store 无这两个字段，审计链已有 actor/ts；若需要详情展示归档时间，应作为独立加性存储设计（Q4），不要在前端伪造。

### 4.6 UI 状态图

```
[admin 项目页]
  loadProjects({includeArchived:true})
    ├─ 200 → live 列表 + archivedProjects → 归档分组
    └─ 失败 → 既有错误态 + 重试

[归档详情]
  cached archived row（先渲染）
    → GET /projects/:id?includeArchived=1
        ├─ 200 → 合并 projectView；显示只读横幅；恢复按钮
        ├─ 404（旧平台）→ 保持 cached；横幅改“当前平台版本不支持归档详情”；仅关闭
        └─ 网络 → refreshFailed 提示；保持 cached；恢复仍可尝试
```

### 4.7 错误与空态

| 场景 | UI |
|---|---|
| 旧服务端不支持 opt-in | 详情保留列表摘要 + 明确“平台版本不支持归档详情”；不显示假数据错误为“读取失败” |
| 归档详情 404（权限竞态） | `refreshFailed`；不自动关闭弹框；恢复按钮按列表状态仍可见（服务端会再校验） |
| 归档项目 grants/policy 404 | UI 预期内，不展示“读取失败”；显示归档说明 |
| 归档分组空 | 不渲染分组 |
| 直达 `#/projects/:id` 但列表无该 id | 既有 `renderDetailNotFound('projects')`；admin 会先加载 archived 列表，因此归档 id 可命中 |
| 恢复成功后详情仍打开 | 关闭详情并刷新列表（项目已变在营，避免在只读层里看旧状态） |

### 4.8 移动端

- 归档详情沿用全屏 sheet；只读横幅在内容顶部，不随滚动消失（放在 sheet 头部下方）。
- 页脚 `恢复项目` 44px；`关闭`/返回 44px。
- 归档分组 summary 44px；展开后卡片与在营卡片同构，仅操作不同。
- 移动端不提供“打开工作区”绕过；既有 `mobileWorkspaceBlocked()` 仍生效。

### 4.9 测试点（含验收断言）

服务端（扩展 `project-archive.e2e.test.ts`）：

1. admin `GET /v1/projects/{archivedId}?includeArchived=1` → **200**，`status=archived`，字段与在营同构。
2. admin 无参数 → **404** `PROJECT_NOT_FOUND`（默认语义不变）。
3. developer/creator 带参数 → **404**；auditor 带参数 → **404**（本期维持 admin-only）。
4. 未知 id 带参数 → 404。
5. archived 的 `PUT /policy`、`PUT /`、`/grants`、`/connect`、`/web-handoff` 仍为 404/409（逐条回归）。
6. `GET /v1/projects` 默认仍不含 archived；`includeArchived=1` 仅 admin。
7. 线兼容对照：用旧请求形状（无参数）跑既有 archive 套件，断言逐字不变。

前端（新增 `web-project-archive-visibility.e2e.test.ts`）：

8. admin 项目页只发 1 次 `GET /v1/projects?includeArchived=1`；工作台不发。
9. 归档行 `详情` 可点；详情出现只读横幅；无 `打开项目`；无权限 tab。
10. 详情请求为 `GET /v1/projects/{id}?includeArchived=1`；stub 404 时文案为“平台版本不支持归档详情”，不显示“读取失败”。
11. 详情内“直接授权”显示归档说明，策略按项目行 + 全局默认渲染；页面无 `PUT /policy` 调用。
12. `#/projects/{archivedId}` 直达可打开；`#/projects/{unknown}` 仍 not-found。
13. 恢复按钮从归档详情发起 1 次 restore；成功后关闭详情、刷新列表、项目回到在营区。
14. 移动视口：只读横幅可见、页脚按钮 44px、无打开工作区入口。

---

## 5. 工作量拆分（每令 ≤20 分钟）与依赖顺序

> 约束：`app.js` 与 `server.ts` 各自串行；同一文件的多令不得并行。每令一个提交、一个验证闭环。
> 总预估：约 3 小时 10 分（不含独立评审）。

| 令 | 估时 | 文件 | 内容 | 退出条件 |
|---|---|---|---|---|
| W1 ✅ `c5c11515cc3`（9/9+71/71） | 完成 | `apps/api/src/server.ts`、`test/e2e/project-archive.e2e.test.ts` | G06 opt-in 只读详情守卫 + 服务端 7 条断言（200/404/权限/仍拒绝写） | 新用例绿；既有 archive 套件绿；`pnpm tc:node` |
| W2 ✅ `29e02c55842`（4/4+39/39） | 完成 | `apps/web/app.js` | 数据层：`state.archivedProjects`、`loadProjects({includeArchived})`、详情路由查找合并、`openDisabledReason` 补 provisioning/failed | 工作台/设置调用零变化；直连归档详情的存在性判断可命中 |
| W3 ✅ `49656b8ab40`（8/8+16/16） | 完成 | `apps/web/app.js` | 项目页：admin 归档分组 `<details>`、`已归档 N` chip、搜索/过滤语义、空态 | 桌面/移动 DOM 分组正确；workbench 不发 includeArchived |
| W4 ✅ `e2cddadc888`（7/7+41/41+16/16） | 完成 | `apps/web/app.js` | 归档/恢复入口（行、卡片、详情页脚）+ `dialog()` 确认 + 请求/刷新/toast/错误映射 | 两个确认文案逐字；取消 0 请求；成功/失败状态正确 |
| W5 ✅ `b1b72d6c446`（5/5+12/12+37/37+16/16） | 完成 | `apps/web/app.js` | 归档详情只读：横幅、隐藏权限 tab、跳过 grants、opt-in 请求、旧平台降级、恢复后关闭 | 无打开/无写请求；404 降级文案正确 |
| W6 🔄 进行中 | 15m | `apps/web/styles.css` | 归档分组、summary、危险按钮间距、移动卡片操作、sheet 横幅/页脚 44px | 700px 与桌面截图核对；无新增颜色/字号 |
| W7 | 20m | `apps/web/app.js` | G27 全量策略表：三态 select、来源徽标、统计、`expectedVersion`、行级 409 保留选择+刷新重试、失败回滚 | 跟随全局项目可新建覆盖；409 不丢选择 |
| W8 | 15m | `apps/web/styles.css` | G27 桌面表格与 ≤700 卡片、select 44px/16px、冲突提示布局 | 移动端单列可操作；无横向溢出 |
| W9 | 20m | `test/e2e/web-project-archive.e2e.test.ts`（新）、`web-exploratory-fixes.e2e.test.ts` | U116 前端 9 条 + 更新 R5-②（admin 项目页现在会带 includeArchived，工作台仍不带） | 新套件绿；R5-② 改后绿 |
| W10 | 20m | `test/e2e/web-project-archive-visibility.e2e.test.ts`（新） | G06 前端 7 条 + 服务端旧请求对照 | 新套件绿；直达/降级/只读断言全过 |
| W11 | 20m | `test/e2e/web-download-policy.e2e.test.ts` | G27 10 条：更新 M120c2-1/2/3/7，新增全量/新建覆盖/409 行级/文案事实性 | 套件绿；旧“只列 explicit”断言全部替换 |
| W12 | 15m | 回归套件 | `project-archive`、`project-download-policy`、`policy-version-conflict`、`web-project-detail`、`admin-gating`、`web-admin-gating` | 全绿；`pnpm run check:code-quality:changed` 0 新发现 |

### 依赖图

```
W1 (server)
  └─ W2 (app.js 数据层)
       ├─ W3 (项目页分组)
       │    └─ W4 (归档/恢复交互)
       │         └─ W5 (归档详情只读)
       │              └─ W6 (styles)
       │                   └─ W9 (U116 测试) ─┐
       ├─ W7 (settings)                        │
       │    └─ W8 (styles)                     │
       │         └─ W11 (G27 测试) ────────────┤
       └─ W10 (G06 前端测试) ──────────────────┤
                                               └─ W12 全量回归
```

- W1 必须先于 W5/W10（否则归档详情请求只能测降级路径）。
- W3→W4→W5 严格串行（同一 `app.js`，且 W4 依赖分组，W5 依赖详情）。
- W7 与 W3/W4 同文件，必须在 W6 之后按序执行；不得并行。
- W9/W10/W11 可在实现全部落定后并行（不同测试文件）；但 `web-download-policy` 的更新与 W7 语义强绑定，建议 W11 紧随 W7/W8。

---

## 6. 终审项（T）

| ID | 结论/待确认 | 影响 |
|---|---|---|
| T1 | 管理台归档/恢复入口仅 `isAdmin()`；服务端“创建者自助归档”保留但不做 UI | 与需求“权限 admin”一致；无服务端回归 |
| T2 | U53③ 解释为“归档不进在营视图”：工作台永不加载；admin 项目页新增独立折叠历史分组 | 必须更新 `web-exploratory-fixes` R5-② |
| T3 | G06 采用 `?includeArchived=1` opt-in，admin-only；默认 404 不变；auditor/创建者维持 404 | 线兼容最稳；若要求 auditor 可读需另开权限决策 |
| T4 | 恢复后状态按 `repoUrl`：有仓库 provisioning，无仓库 ready；文案不承诺固定经 provisioning | 与 `server.ts:3018-3021` 事实一致 |
| T5 | `openDisabledReason` 增加 provisioning/failed 因由 | 修复恢复后“可点但 409”的体验 |
| T6 | G27 只列在营项目；归档不参与策略、不在设置页恢复 | 与需求“全部在营项目”一致 |
| T7 | 项目策略行保存必须带 `expectedVersion`（共享全局版本）；409 保留选择+刷新重试 | 防止并发静默覆盖 |
| T8 | 不做同步 ack、不显示“已同步”、不持久“待同步”标记；只说“随宿主心跳生效” | 事实性文案，延续 U145/G27 结论 |
| T9 | G06 无新字段/新 opcode/版本号；G27 无接口变更 | 无需协商版本 |
| T10 | 归档确认用 `dialog()` + `.btn.danger`，不用 `window.confirm`；Esc/遮罩取消 | 与主机下线等危险操作一致 |
| T11 | 归档文案明确“主机目录与代码不删除”；归档不触发任何磁盘删除 | 与 M65 限制 1 一致 |
| T12 | G27 一期一次性渲染全部在营项目，不加分页；先加搜索（若 W7 有余量） | 200 项目列表已有 P95 基线；超过规模走 Q6 |

---

## 7. 开放问题（Q）

| ID | 问题 | 建议 |
|---|---|---|
| Q1 | 创建者是否需要在控制台自助归档自己的项目？（服务端已允许） | 本期按需求仅 admin；若产品要开放，另立 UI 权限令，不混入本批 |
| Q2 | auditor 是否应能看归档详情？ | 本期维持 404；若审计需要，按“只读审计面”统一设计，不单独放开 |
| Q3 | 归档分组默认展开还是折叠？ | 默认折叠；点 `已归档 N` chip 时只显示归档并展开 |
| Q4 | 是否需要在详情显示归档时间/操作者？ | store 无 `archivedAt/archivedBy`；审计链可查。若必须展示，另做加性持久化 + 迁移，不在本批伪造 |
| Q5 | 恢复撞 key/path 时是否提供“查看占用项目”跳转？ | 一期只给文案 + 刷新；自动跳转需要解析冲突详情（当前 409 不带占用 id） |
| Q6 | 设置页项目数很大（>200）时是否需要搜索/分页/虚拟滚动？ | 一期全量；若真实规模超 200，加搜索框（纯前端过滤）优先于分页 |
| Q7 | 移动端归档入口是否收进“更多”菜单？ | 不；保留项目页 chip + 卡片操作，避免底栏语义膨胀 |
| Q8 | G27 是否要列归档项目的策略（只读）？ | 不列；需求明确“在营”，且设置页不应成为恢复入口 |
| Q9 | 行保存后是否在本地保留“等待心跳”视觉标记？ | 不保留持久标记；仅 toast，刷新即事实态 |
| Q10 | 恢复后 provisioning 失败是否在列表提供“重试准备”？ | 现有项目更新/创建有重试链路；恢复是否复用需确认（建议复用同一入口，不新建） |

---

## 8. 验收覆盖索引（便于派测试）

| 验收点 | 对应测试 | 所在套件 |
|---|---|---|
| 归档入口仅 admin、确认文案、取消 0 请求 | U116-1/2 | `web-project-archive` |
| 归档分组/过滤/搜索/空态 | U116-7 | 同上 |
| 恢复状态机（provisioning/ready/failed） | U116-4/9 | 同上 |
| 恢复 key/path 冲突 | U116-5 | 同上 |
| 审计事件 | U116-6 | 服务端 `project-archive` + 前端 |
| G27 全量行/三态/新建覆盖 | G27-1/2/3 | `web-download-policy` |
| G27 409 行级冲突/失败回滚 | G27-6/7 | 同上 |
| G27 文案事实性 | G27-9 | 同上 |
| G06 opt-in 200/默认 404/权限 | G06-1..6 | `project-archive`（服务端） |
| G06 只读详情/旧平台降级/直达路由 | G06-8..14 | `web-project-archive-visibility` |
| 线兼容（旧无参数请求逐字不变） | G06-7 | `project-archive` |

## 主会话裁定（2026-11-16，按用户决策程序与四标准）

- 终审项 T1–T12 **全部采纳**。
- Q1 否（一期不做创建者自助归档 UI）；Q2 否（auditor 维持 404）；Q3 默认折叠；Q4 否（store 无归档时间/操作者字段，暂不展示）；Q5 一期不做（409 无占用 id）；Q6 先加前端搜索（>200 项目）；Q7 不收进更多；Q8 不列归档项目；Q9 只 toast；Q10 复用现有「重试准备」入口。
- 执行顺序：W1 可先行（server 域，与移动端 M5-M7 并行）；W2+ 与 app.js 线串行。
