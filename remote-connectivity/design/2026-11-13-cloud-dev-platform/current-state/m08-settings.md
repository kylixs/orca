# M8 平台设置（下载策略）

> 基线提交：`664a91e0322`（2026-11-16 工作区快照；工作树 U106-R3 未提交改动不影响设置页）。
> 前端：`cloud-platform/apps/web/app.js`（`renderSettings` / `saveProjectPolicy` / `policyOverrides`，约 L2542-2648）。后端：`cloud-platform/apps/api/src/server.ts`（`GET/PUT /v1/policies/download`、`PUT /v1/projects/{id}/policy`）。

## 1. 页面/界面布局

路由 `#/settings`，面包屑「平台设置」。

- **页头**：标题「平台设置」；副标题「下载策略：全局默认与项目覆盖。」（e2e 断言为页面的真实能力，不出现页面没有的设置项）。
- **卡片 1：全局下载策略**（`.card.pad`，max-width 640px）：
  - h2「全局下载策略」；说明「项目级策略可覆盖全局；托管项目默认禁止下载。」
  - 两个 radio（`name=dl`）：
    - `deny`「禁止下载」：隐藏导出入口；主机拒绝专用下载 RPC；阻断浏览器下载；
    - `allow`「允许下载」：保留导出通道，仍记录审计。
  - 黄色 note：「内容级 DLP（终端复制、文件内容读取）一期不做阻断，仅限速与审计。」
  - 「保存」按钮（`#savePolicy`，primary）+ 灰字「当前版本 v<N>」；版本冲突时按钮上方出现黄色冲突条 `#policyConflict`（默认隐藏，含「刷新后重试」）。
- **卡片 2：项目级覆盖**：
  - h2「项目级覆盖」；说明「独立覆盖钉住该项目的下载策略，全局默认翻转时不随之变化；选「跟随全局」即恢复。」
  - 范围统计 `#policyScope`：「跟随全局默认 N 个项目 · 独立覆盖 M 个项目」。只统计**在营项目**（`status !== 'archived'`）。
  - 覆盖表（仅 `downloadPolicyExplicit === true` 的项目，3 列）：
    - 项目：名称加粗 +「覆盖」徽标 + 路径（等宽灰字）；
    - 覆盖策略：下拉 `[data-policy-select]`，选项 禁止 / 允许 / 跟随全局；
    - 当前生效：按 `effectiveDownloadPolicy` 计算「禁止」或「允许」。
  - 空态：「暂无项目覆盖，全部项目跟随全局默认。」
- **无**：客户端最低版本、会话超时、LDAP 配置、审计保留期、通知、DLP 开关等其他设置；当前设置页只有下载策略两卡片。

## 2. 菜单与入口

- 侧栏 `#adminNav` 的「平台设置」按钮；仅 `platform:admin` 可见；auditor/developer 隐藏。
- 直达 `#/settings`：非管理员 → 「无权访问」页（保留 URL），不渲染策略卡片，也不发任何策略读写请求。
- 数据接口 admin-only：非管理员直调 `PUT /v1/policies/download` 或 `PUT /v1/projects/{id}/policy` → 403 `PERMISSION_DENIED`，不落变更。

## 3. 操作清单

| #   | 触发                            | 结果                                                                                                                                                     | 弹窗/确认  | 失败态                                                                                       |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| 3.1 | 打开 `#/settings`               | 并行 `GET /v1/policies/download` + `GET /v1/projects`；渲染全局卡、范围统计、覆盖表或空态                                                                | 无         | 「加载失败」+ 错误文本 + 「重试」                                                            |
| 3.2 | 切换全局 radio 后点「保存」     | `PUT /v1/policies/download { downloadDefault, expectedVersion }`（页面加载时读到的 `version`）→ 成功 toast「已保存，将随宿主心跳生效；跟随全局 N 个项目，独立覆盖 M 个不受影响」→ 整页重绘并显示新版本 | 无二次确认 | 409 `POLICY_VERSION_CONFLICT`：卡内黄条「策略已被他人修改」+ 服务端当前 `version` 与全局默认，radio 保留用户选择，「刷新后重试」重新 GET 版本后按用户选择重放；其他错误 toast「保存失败：<原因>」+ 立即 `renderSettings()` 按服务端值重绘（表单不保留未落库值） |
| 3.3 | 修改某覆盖行下拉为「禁止/允许」 | `change` 即保存：`PUT /v1/projects/{id}/policy { downloadPolicy }`（覆盖表不含项目策略版本，行级保存仍为 last-write-wins，不带 `expectedVersion`）；成功 toast「已保存项目下载策略」→ 整页重绘，并恢复滚动位置与刚操作的 select 焦点     | 无确认     | toast「保存失败：<原因>」+ 重绘回服务端值（行不重复、不回弹到页顶；失败路径不恢复滚动/焦点） |
| 3.4 | 某覆盖行选「跟随全局」          | `PUT /v1/projects/{id}/policy { inherit: true }`；清除钉住；成功 toast「已恢复跟随全局默认」→ 该行移出覆盖表，统计「独立覆盖」减一                       | 无确认     | 同 3.3                                                                                       |
| 3.5 | 全局翻转（deny→allow 或反向）   | 钉住项目保持不变，跟随项目按新全局值生效；覆盖表「当前生效」列、工作台项目卡与「我的项目」下载策略列同步体现生效值                                       | 无         | 同 3.2                                                                                       |
| 3.6 | 某项目被归档                    | 从「跟随全局 / 独立覆盖」统计与覆盖表中剔除（历史不参与策略管理）                                                                                        | 无         | 无                                                                                           |
| 3.7 | 关闭/刷新页面                   | 无草稿保护；所有保存均为即时请求，无「取消=丢弃草稿」语义                                                                                                | 无         | 无                                                                                           |

生效与数据语义：

- 全局默认出厂为 `deny`；项目可显式 `deny`/`allow` 钉住，或 `inherit` 跟随。
- 全局保存后「将随宿主心跳生效」是事实性文案（平台无下发成功回执或最后同步时间），页面本身即时重绘。
- `downloadPolicyExplicit` 区分「显式钉住」与「只是存了与全局相同的值」：覆盖表只列显式钉住项。
- 全局保存为乐观并发：页面加载时记录 `version`，保存携带 `expectedVersion`；陈旧写入返回 409 并在卡内保留输入、展示服务端版本/值，可「刷新后重试」。成功响应回写本地 `version`。
- 行级覆盖保存仍为 last-write-wins，无版本号/冲突检测（覆盖表数据源不含项目策略版本）。

## 4. 数据来源

- `GET /v1/policies/download` → `{ downloadDefault: 'deny'|'allow', version }`。
- `PUT /v1/policies/download` body `{ downloadDefault, expectedVersion? }` → 新版本；版本不匹配 → 409 `POLICY_VERSION_CONFLICT`（`error.details` 含服务端 `version`、`downloadDefault`、`readRatePerHour`）；写 `policy_update` 审计（target `download`，失败含 `reason/expectedVersion/resultVersion`）。`downloadDefault` 必填 `allow`/`deny`，缺失或非法 → 400 `POLICY_INVALID`（不再默认 deny；校验在认证/授权/`auditAllowsMutations` 之后，`server.ts:6568-6582`，`097025df563`）。
- `GET /v1/projects` → 项目的 `downloadPolicy`、`downloadPolicyExplicit`、`status`、`name`、`path`；前端计算 `following` / `overrides`。
- `PUT /v1/projects/{id}/policy` body `{ downloadPolicy }` 或 `{ inherit: true }`（可另带 `readRatePerHour`，本页不发）→ 写 `policy_update` 审计；`inherit` 的 metadata 带 `inherited`，不误记 `downloadPolicy`。非 `inherit:true` 时 `downloadPolicy` 必须为 `allow`/`deny`，否则 400 `POLICY_INVALID`（校验在认证/授权/`auditAllowsMutations` 之后，`server.ts:5001-5024`，`097025df563`）。
- 生效值读取：项目视图 `downloadPolicy`（已按全局/覆盖计算）。

## 5. 已知缺陷与观察

已登记：

- **U30**（🟢）M120 UI 打磨批中含 m-7「行级保存整页重绘滚动/焦点重置」，已修并回归。
- **M120c / M120c2**（🟢，见 `tasks.md`）：设置页项目级下载策略覆盖；Q A-009「保存失败静默」已修为 toast + 按服务端值重绘；`inherit` 清除覆盖语义与审计 metadata 已钉。
- **U70**（⚪）宿主下载硬拦残余缺口（首窗口放行等），与设置页策略生效范围相关，属分期语义边界。
- 非缺陷：设置页只有下载策略，没有其他设置项；副标题与 e2e 明确「不出现页面没有的设置项」。

未登记观察（建议登记）：

1. 全局策略保存无二次确认，成功 toast 仅报「已保存，将随宿主心跳生效」；页面无法确认下发是否成功（无状态/最后同步时间）。文案已修正以去掉「30 秒内生效」承诺，同步状态仍待排期。
2. 全局策略保存已由 U136④b 加入乐观并发（保存携带 `expectedVersion`；409 保留输入、展示服务端值与「刷新后重试」）；行级覆盖保存仍为 last-write-wins（覆盖表不含项目策略版本）。
3. 覆盖表只列 explicit 项目，管理员无法在本页给「未覆盖项目」直接钉住，只能先让项目产生覆盖（如通过项目详情/接口），或该能力未暴露。
4. 已归档项目从统计中剔除是正确语义，但页面对「归档项目仍有覆盖记录」无任何说明。

## 6. 测试覆盖

已覆盖（绝对路径）：

- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/web-download-policy.e2e.test.ts`（M120c2-1..9）：零覆盖空态与统计、只列 explicit 项目与生效值、inherit 行移出清单且统计回落、全局翻转后钉住项目不变/跟随项目改变（工作台徽标 + 我的项目列）、保存失败 toast + 回滚且无重复行、非管理员路由拒绝且零写请求 + 直调 403、行级保存重绘保留滚动与焦点、全局保存携带 `expectedVersion` 且版本加一、409 冲突保留输入+服务端值+刷新后重试成功。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/policy-version-conflict.e2e.test.ts`：U136④a 后端协议——全局/项目 PUT 的陈旧 `expectedVersion` 409 且不覆盖、匹配版本正常写入、缺省保持旧行为、非法版本 400、冲突/成功审计 metadata。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/project-download-policy.e2e.test.ts`：未覆盖项目 `explicit=false`、旧形态 PUT、inherit 清除覆盖与审计 `inherited`、全局翻转后 inherit 生效、`readRatePerHour` 语义、非法限速 400、非 admin 403 + denied 审计。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/web-admin-gating.e2e.test.ts`：开发者管理导航隐藏、强制 `#/settings` 落入无权访问、API 403。
- 证据：`/Users/gongdewei/work/projects/orca/cloud-platform/evidence/m120c2*`（若存在）、`.../evidence/m94-admin-denial-audit/`。

未覆盖：

- 全局保存失败路径的 UI 断言由 T06 QA-009 与 M120c2-9（409 冲突）覆盖。
- 行级覆盖保存的并发冲突未覆盖（该路径不带 `expectedVersion`，仍 last-write-wins）。
- 未覆盖项目在本页直接钉住的能力不存在，也无测试。
- 设置页移动端布局（U80 设计已交付，自动化几何断言未覆盖）。

## 7. 基线提交

`664a91e0322d90e4d32ce9d092526159c3052854`。本模块无工作树在途改动。
