# 云端开发平台一期 · 人工验收指引（M111）

> **已被 [`acceptance-runbook-v2.2.md`](./acceptance-runbook-v2.2.md) 取代**；2026-11-17 批次的自动门证据与人工项见该文 §8，本文件仅留作历史记录。

> 配套 `acceptance-index.md`（机器校验的证据索引）。自动化已证明的行为这里不重复断言；
> 本指引回答「验收人**亲手做什么、应看到什么**」。每行标注 AC 与已有自动化证据。
> 结论词汇同 test-plan：PASS / PASS(部分) / UNVERIFIED。

## 0. 准备

- 平台：`node cloud-platform/apps/api/src/server.ts`（或部署实例）；管理员 `admin / Adm1n!`，开发者 `zhangsan / Passw0rd!`（组 `team-payment`）。
- 桌面端：云构建的 Orca（`ORCA_CLOUD_API_URL` 指向平台；宿主机再配 `ORCA_CLOUD_HOST_TOKEN` + `ORCA_CLOUD_TLS_CERT_PATH/KEY_PATH`）。
- 管理员浏览器：平台 Web（登录即管理导航）。

## 1. 开发者桌面主流程

| 步骤 | 人工验证 | AC | 自动证据 |
|---|---|---|---|
| 登录 | 域账号登录 → 直入原生界面，侧栏出现本人 checkout（`.orca-worktrees/<用户名>/main`） | AC-01/04/16 | `m70-acceptance`、`m95-admin-grant-open`、`m66-session-persistence` |
| 线路与延迟 | 工作区顶部显示 直连/中继 + 延迟；「连接诊断」面板列出逐地址尝试 | AC-05/07 | `m101-open-route-diagnostics` |
| 终端 | 打开终端输入命令，回显即时（本机路径 P95 7.5–9.1ms） | AC-05 | `m90-terminal-over-relay`、`m102-terminal-echo-latency` |
| 文件 | 浏览 1000 项目录应流畅（本机 P95 3.3–5.1ms）；托管项目无任何下载入口 | AC-10/27 | `m103-file-listing-latency`、`m92-managed-no-export` |
| 重启 | 完全退出再启动：免密恢复、设备身份不变 | AC-16 | `m66-session-persistence`、`m98-session-user-isolation` |

## 2. 连接与线路演练

| 演练 | 人工验证 | AC | 自动证据 |
|---|---|---|---|
| 直连可达 | 打开项目秒级可用（本机建连 P95 6.3ms） | AC-05 | `m104-connection-latency` |
| 直连断 → 中继 | 断开直连路由，自动回落中继，徽标变「中继」 | AC-06 | `m90`、`E2-relay.json` |
| 双断 | 直连+中继全断：失败面板显示错误码、逐地址耗时、可复制、重试 | AC-07 | `m91-connect-diagnostics` |
| 主机离线 | 宿主机停心跳 ≤60s：项目行转灰「主机离线」、禁用打开 | AC-08 | `m74-offline-host` |
| 平台停机 | 平台进程停止：已开会话不死，新开报 `PLATFORM_UNAVAILABLE` | AC-20 | `m75-platform-unavailable` |
| 宿主换证书 | 替换宿主 TLS 证书（不改平台发布值）：客户端拒绝并提示，**不发任何项目数据** | §5.3 | `m109-host-tls-pinning` |
| 主机维护 | 宿主进入维护：新连接 409 `HOST_MAINTENANCE`，已有会话不断 | AC-09 | `m70-acceptance` |
| 版本门 | 旧客户端登录成功、打开项目 426 `VERSION_UNSUPPORTED` 带最低版本 | AC-15 | `E7c-version-gate.json` |
| 策略下发 | 管理员改下载策略 ≤30s 生效（心跳携带，无需手动刷新） | AC-17 | `m79-policy-propagation` |
| Web 独立发布 | 前端发新版本：旧页面缓存的资源 URL 不 404 | AC-19 | `m78-web-release` |
| 伪造凭证 | 过期/伪造票据升级：401 + `x-orca-reject`，101 前无数据帧，写审计 | AC-21 | `m70-acceptance`、`m46-browser-upgrade` |
| 中继切换 | 杀一台中继：客户端 5 次退避内重连，40 次新会话全部成功 | AC-23 | `m83-relay-failover` |

## 3. 管理员 Web 流程

| 步骤 | 人工验证 | AC | 自动证据 |
|---|---|---|---|
| 权限边界 | 开发者登录 Web：无管理导航；直击管理接口 403 且写审计 | AC-18 | `m8-admin-gating`、`m93`、`m94-admin-denial-audit` |
| 项目交付 | 管理员建项目 + 授权组 → 开发者刷新即见并可打开 | AC-04 | `m95-admin-grant-open` |
| 审计 | 审计页查近 7 天，按 traceId 精确追到一次连接 | AC-13 | `m89-audit-trace-window` |
| 密钥/证书 | 换宿主 E2EE 公钥：Web 与桌面都弹指纹比对对话框，确认后重固定 | AC-29 | `m77`、`m81`、`m82-web-host-key` |

## 4. 安全演练

| 演练 | 人工验证 | AC | 自动证据 |
|---|---|---|---|
| 锁定 | 连错 5 次密码：423 锁定 15 分钟，有审计 | AC-02 | `m70-acceptance`、`m84` |
| 探测 | 无权限项目：响应统一 404，不泄露项目名 | AC-03 | `m8-admin-gating` |
| 下载 | 托管项目读有预算、导出族 RPC 全拒 | AC-10 | `m35-download-policy` |
| 越界 | `../../etc/passwd`、跨用户写：`PATH_OUTSIDE_ROOT` 且写审计 | AC-11/27 | `m36`、`m73-host-audit` |
| 收权 | 清空组授权 ≤60s：已建会话被 4403 关闭（用户级收权只断该用户） | AC-12 | `m88`、`m96-grant-revocation-scope` |
| 吊销主机/设备 | 管理员吊销：新连接立即失败，旧会话 ≤60s 断（4403） | AC-14 | `m71-host-revocation` |
| 令牌泄露 | 吊销设备：访问/刷新令牌立即 401，已建会话 ≤60s 4403 | AC-25 | `m11-revocation`、`m70-acceptance` |
| 越权方法 | 仅 `file:read` 调 `files.write`：`PERMISSION_MISSING`，审计记录方法与权限 | AC-28 | `m34-cloud-rpc-scope`、`m72-denial-details` |
| 工作区边界 | A 打开 B 的 worktree：读放行、写拒（`PATH_OUTSIDE_ROOT`），凭证根受限 | AC-27 | `m36-workspace-boundary` |
| 令牌移植 | 复制凭证到别处：401 `device_mismatch` | AC-30 | `m46-browser-upgrade` |
| 密钥轮换 | 轮换后新旧 `kid` 并行，60 天内旧票据仍可验 | AC-31 | `m76-signing-key-rotation` |
| 审计链 | 改写日志任意一行 → `AUDIT_CHAIN_BROKEN` 全副本 503；锚点可独立验证 | AC-26 | `m80`、`m32`、`m87`、`m100` |
| 数据面 | 平台跳/中继出向抓包：只有密文与元数据，无负载明文 | AC-24 | `m85`、`m86`、`m10-relay` |

## 5. 性能与容量（已自动化，人工只需复核报告）

- 登录→工作台 P95 71ms（浏览器）/ 245ms（原生）；200 项目列表 P95 75–78ms；建连 6.3/6.1ms；回显 9ms；1000 项目录 5ms；31 天审计查询 7.3ms@20 万条 —— §5.1 全部在预算内，证据见 §4.3 各行。
- AC-22：300 并发 30 分钟，269,628 RPC 零失败（`m110-load-300`）。**注意**：本机回环数据，生产容量结论需目标硬件复测（可沿用该测试）。

## 6. 剩余未验证项（需要环境，勿在本轮勾选）

| 项 | 缺什么 | 建议环境 |
|---|---|---|
| AC-32 | WAF/DMZ 真实网络 | 非 VPN 外网客户端打管控接口应被 WAF 拒，工作台不受影响 |
| G-04 收尾 | Redis Stream 队列、PostgreSQL/对象存储归档 | 部署形态落地时实现并回归 AC-26 |
| 生产容量 | 目标硬件 | 2000 并发 TCP/2Gbps 中继、WAN P95；沿用 `load-300.test.ts` |
| 真实证书链 | 平台 CA 签发证书 | 验证宿主 TLS 链校验与管理员 Web 的传输安全（浏览器端无法做指纹固定） |
| 跨平台 | Windows/WSL/SSH 宿主机 | provisioning、路径边界、PTY、会话持久化各跑一遍 |
