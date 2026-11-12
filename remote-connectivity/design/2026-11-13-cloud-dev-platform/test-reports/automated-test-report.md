# 自动化测试报告（一期实现）

> 日期：2026-11-13
> 被测代码：`cloud-platform/`
> 证据目录：`cloud-platform/evidence/`（已 gitignore，不提交）

## 1. 环境

| 项 | 值 |
|---|---|
| 平台 | macOS (darwin 24.6.0) |
| Node | v24.5.0（直接执行 TypeScript，无构建步骤） |
| 依赖 | 仅复用仓库已有 `ws@8.22.0` |
| TLS | 测试内 `openssl` 生成自签证书（CN=dev-001.relay.local） |
| 加密 | Ed25519 凭证签名 / 验签（Node crypto） |

## 2. 单元测试

命令：`cd cloud-platform && node --test test/contract.test.ts`

| 用例 | 结果 |
|---|---|
| 凭证签名与验签往返 | PASS |
| 篡改载荷导致验签失败 | PASS |
| 过期与未知 kid | PASS |
| 未登记方法默认拒绝 | PASS |
| 读允许 / 写需权限 / 导出恒拒绝 | PASS |
| 路径穿越与绝对逃逸拒绝 | PASS |
| 审计哈希链追加、校验、篡改定位 | PASS |
| 导出规则先于 browser 前缀匹配 | PASS |

合计：**8 passed / 0 failed**

## 3. 端到端测试

命令：`cd cloud-platform && node --test test/e2e/platform.e2e.test.ts`

拓扑：真实子进程 `API` + `relay` + `runtime-sim`，真实 TCP/TLS，真实 Ed25519 凭证。

| 编号 | 场景 | 断言 | 结果 | 证据 |
|---|---|---|---|---|
| E1 | 登录 → 项目列表 → 直连打开 | 路由为 direct；RPC 可用；文件可读 | PASS | `evidence/e2e-platform/E1-direct.json` |
| E2 | 直连不可达 → 中继回落 | 路由为 relay；SNI 转发后 RPC 可用 | PASS | `E2-relay.json` |
| E3 | 伪造凭证升级 | 升级被拒（非 101） | PASS | `E3-forged-credential.json` |
| E4 | 无 `file:write` 时写文件 | 返回 `PERMISSION_MISSING`；读仍可用 | PASS | `E4-method-permission.json` |
| E5 | 下载策略 deny 下调用 `files.download` | 返回 `EXPORT_DENIED` | PASS | `E5-export-denied.json` |
| E6 | 路径穿越 / 跨工作区写越界 | `../../etc/passwd` 拒绝；写项目根拒绝；写自己工作区成功 | PASS | `E6-path-boundary.json` |
| E7 | 权限收回 | 旧凭证被拒；新登录看不到项目 | PASS | `E7-revocation.json` |
| E8 | 平台停机 | 已建立会话 RPC 仍成功；新登录失败 | PASS | `E8-platform-down.json` |
| E7a | 符号链接写逃逸 | 写入被拒（`PATH_OUTSIDE_ROOT`），目标目录未生成文件 | PASS | `E7a-symlink-escape.json` |
| E7b | 凭证移植到另一设备 | 他人设备 401；原设备 101 | PASS | `E7b-device-transplant.json` |
| E7c | 客户端版本过低 | 平台返回 426 `VERSION_UNSUPPORTED` | PASS | `E7c-version-gate.json` |
| E7d | 托管工作区创建 | 路径落在 `workspaceRoot` 内且幂等 | PASS | `E7d-managed-worktree.json` |
| E9 | 证据汇总 | 证据落盘 | PASS | `summary.json` |
| E10 | 中继未知 SNI / 非 TLS | 连接被黑洞 | PASS | `E10-relay-blackhole.json` |

合计：**14 passed / 0 failed**；加上 M8 的 13 条与 8 条单元测试，共 **35 条全绿**

## 3.1 管控面门禁测试（M8）

命令：`cd cloud-platform && node --test test/e2e/admin-gating.e2e.test.ts`

| 场景 | 结果 | 证据 |
|---|---|---|
| 开发者访问 8 个管理接口（主机、注册令牌、登记项目、授权、项目策略、归档、审计、全局策略） | 全部 403 `PERMISSION_DENIED` | `evidence/m8-admin-gating/` |
| 管理员访问只读管控接口 | 全部 200 | `admin-readonly-success.json` |
| 未登录访问管控面 | 401 `SESSION_EXPIRED` | `anonymous-admin-access.json` |
| 被拒操作审计 | 存在 `denied` 事件，actor 为被拒用户 | `denied-audit.json` |
| 未知项目 vs 无权限项目 | 状态码与错误体一致（除 traceId） | `existence-non-disclosure.json` |

合计：**13 passed / 0 failed**

## 4. Web UI 实测

工具：Playwright 驱动真实浏览器访问 `http://127.0.0.1:18787/`，后端为真实 API + Agent 心跳。

| 页面 | 实测结果 | 截图 |
|---|---|---|
| 登录 | 域账号登录成功；错误密码内联提示 | `evidence/web-ui/` |
| 工作台 | 统计卡 4 项、项目卡、项目表渲染正确 | `01-workbench.png` |
| 打开项目 | 返回直连/中继地址与凭证有效期对话框 | `02-connect-dialog.png` |
| 主机 | 在线状态、直连地址、中继路由正确 | `03-hosts.png` |
| 成员与权限 | 授权矩阵、下载列锁定 | `04-members.png` |
| 审计日志 | 8 条真实事件，含 traceId | `05-audit.png` |
| 平台设置 | 默认策略 deny，可保存 | `06-settings.png` |
| 403 | 无权限页可访问 | `07-forbidden.png` |
| 开发者视图 | 管控导航不渲染 | `08-developer-workbench.png` |

## 5. 未覆盖与后续

| 项 | 原因 | 后续 |
|---|---|---|
| 真实 Orca Runtime（`orca serve`）联调 | 本机无构建产物 | 需先构建 out/cli，再以 `e2ee_hello/e2ee_auth` 接入 |
| 桌面客户端补丁层 | 需在 Orca 根工程实现并跑 typecheck/lint | 见 tasks.md T201–T211 |
| 审批流 / DLP | 二期范围 | 二期 |
| 300 并发压测 | 需独立压测环境 | 见 tasks T507 |
| LDAPS 真实连接 | 无可用 LDAP 实例 | 适配器接口已就绪，接入真实 LDAPS 即可 |
