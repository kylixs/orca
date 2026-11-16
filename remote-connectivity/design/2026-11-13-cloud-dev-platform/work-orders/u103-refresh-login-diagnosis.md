# U103 诊断：刷新 Orca Web 后停留登录面、无法打开工作区

状态：诊断完成（只读取证；未改代码/持久进程）
环境：https://127.0.0.1:18787/（admin/Adm1n!，demo 项目），取证时间 2026-11-16 12:03–12:20
证据：`evidence/u103/`（probe 脚本、probe-result.json、截图；不入 git）

## 1. 复现路径与结果

真实浏览器（headless Chromium，ignoreHTTPSErrors）：

1. 平台登录 → 项目行 `Orca Web` 按钮打开 popup：
   `https://100.67.197.59:18444/h/dev-local-02/web-index.html?api=https%3A%2F%2F127.0.0.1%3A18787`
2. popup 正常进入工作区（`.app-layout` 可见），localStorage 含
   `orca.webCloudSession`（access+refresh token）、`orca.webCloudDeviceKey`、
   `orca.web.runtimeEnvironment.v1`（name=`demo-app (cloud session)`，含
   `cloudLoginRequired: true`）、`orca.web.workspaceSession.v1`。
3. `page.reload()` 后 8s/15s 均停在 WebConnect：
   `Connect to Orca` + `Your cloud session ended when this page closed. Sign in again to continue.`
   `orca.web.runtimeEnvironment.v1` 已被删除；`orca.webCloudSession` 原样保留。
4. 控制台/网络：无资产 404、无 JS 语法错误；刷新后唯一失败请求是重连尝试的 403。
5. 按页面提示用 Cloud account 重新登录 admin/Adm1n! → 报
   `PROJECT_FORBIDDEN / 项目无权限，无法打开。`，仍进不了工作区。

复现确定性：12:0x（构建替换已完成）仍 100% 复现，且为纯客户端启动策略路径，
与「刷新瞬间是否撞上 11:53 构建窗」无关；硬刷新/清缓存不能恢复。

## 2. 分面定性

### A 环境窗（构建替换/版本错配）——不是本症状的原因

- 宿主 web 服务从磁盘 `out/web` 实时取文件：popup index 引用
  `assets/web-BasQbr3T.js`（11:53 构建），与磁盘一致；无 404。
- 宿主 main 进程 10:00:38 启动，内存里确为旧 main；`out/main` 11:53 被替换
  ——版本错配真实存在（U96 A-4 能力协商会因旧宿主不广播
  `cloud.session-tabs-restore.v1` 而降级），但：
  - 刷新前新 client × 旧 main 已成功打开工作区；
  - 刷新回登录是启动策略路径，和 main 版本无关（全新构建+隔离宿主也可复现）。
- 结论：A 是背景风险（应收尾重启宿主对齐 11:53 构建），不是 U103 的因。

### B 代码级策略 + 恢复链缺陷——本症状的因

**B1（F5 强制回登录，策略问题）**
- 云端条目创建时 `web-cloud-connect.ts:131` 写入 `cloudLoginRequired: true`
  （注释即 “a reload must still return to sign-in”）。
- `web-root.tsx:48` 启动时据此把 stored env 判为已结束 → 删除 env → WebConnect；
  handoff hash 已在进入时被 `clearWebHandoffFromAddressBar()` 抹掉，刷新无票据可重放。
- 但 `orca.webCloudSession` 里的 access(30min)/refresh(12h) token 仍在且有效，
  启动路径**没有**任何 `restoreWebCloudSession`/refresh 续会话尝试
  （该恢复能力已在 `web-cloud-session-restore.ts` 存在，仅桌面 cloud-browser 路径使用）。
- 该策略自 2026-11-13（fe88ea/990054/bacb3be）就存在，不是今日 U96 A-4/A-5 引入；
  但它是「F5 即登录」的直接原因，属可修的产品策略缺口。

**B2（重新登录也进不了工作区，恢复链 bug）**
- 刷新后的 WebConnect 表单 Platform address 为空：popup URL 有 `?api=`，
  但该参数只服务 handoff 入口，未预填到 Cloud account 表单。
- 即使手动填地址并登录成功，`web-cloud-connect.ts:157 selectProject()`
  直接取 `projects[0]`；`GET /v1/projects` 首位是 `proj_payment`
  （payment-service，admin 的 `permissions: []`），`POST /v1/projects/proj_payment/web-handoff`
  返回 403 `PROJECT_FORBIDDEN`——与页面报错一致；demo 项目
  `proj_6dc390d2` 的同接口 201。
- 结论：用户刷新后唯一的自助恢复路径被首项目选择逻辑打死。

## 3. 修复方向

1. **最小修复（B2，先做）**：WebConnect 预填 `?api=`；`selectProject` 在无
   `projectId` 时只选 `permissions` 含 `open`（且 host online）的项目，或改为显式项目选择；
   防止把不可开项目当默认。
2. **策略修复（B1，根因）**：刷新启动时若 `orca.webCloudSession` 存在且 refresh 有效，
   用 `restoreWebCloudSession` 续会话并对记住的 projectId（建议随 env 持久化）
   重新 mint handoff，自动回到工作区；失效才回 WebConnect。这样 F5 不再强制重登。
3. **环境收尾（A）**：代码修复后重启 18787 宿主进程，使内存 main 与 11:53
   `out/main` 对齐（幂等 reseed 即可），避免能力协商降级与后续验收混入旧 main。

验证方式：同一 headless 脚本（`evidence/u103/probe-refresh.mjs`）在修复后断言
reload 后 `.app-layout` 可见、workspaceSession 未丢；`probe-reconnect.mjs` 作为
恢复链负控改绿。
