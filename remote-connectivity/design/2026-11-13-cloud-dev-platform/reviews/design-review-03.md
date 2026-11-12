# 设计评审 03（v1.2 → v1.3 复核）

> 日期：2026-11-13
> 范围：requirements.md、design.md、diagrams.html、tasks.md + `cloud-platform/` 实现
> 结论：**REJECTED**（无 BLOCKER；4 个 MAJOR 未闭环 + 3 个实现安全缺陷）

## 复核结果

| 复核项 | 结论 |
|---|---|
| `worktree.createManaged` 设计与需求 | PARTIAL（tasks 缺任务） |
| 中继路由同步表述 | PARTIAL（正文已改，图表缺连线） |
| 外网 allowlist 与 §12.1 一致 | PARTIAL（workspaces 两条未列入） |
| `browser` 权限可授予 | PARTIAL（未进 Permission 类型/矩阵/需求） |
| 图 4 契约 | CLOSED |
| §21 AC 映射编号 | CLOSED（语义归属有 2 处偏差） |
| 状态机 / AC 引用 / deviceId / 容量 / 审计副本 / 链接 / TTL / 升级期拒绝 / Redis 前提 | CLOSED（3 项有残留） |
| AC-19 负责任务 | REGRESSION |
| 一期验收出口 AC 范围 | 新发现 MAJOR |

## 实现一致性发现

| 级别 | 问题 |
|---|---|
| MAJOR（安全） | `executeWrite` 未做 realpath，符号链接可逃出 workspaceRoot；`startsWith` 前缀判断缺分隔符，同前缀目录误判 |
| MAJOR | 方法映射缺 `browser.*`、`worktree.createManaged`、`terminalArtifact.*`、`agentProvider.*` |
| MAJOR | 升级期缺用户/jti 撤销消费、设备公钥绑定断言、jti TTL 清理 |
| MINOR | `/connect` 缺 `tlsFingerprint`；客户端版本门禁未实现 |
| MINOR | 客户端缺 failoverBudget 重试与分层错误码 |

## 修订记录

| 项 | 处理 | 证据 |
|---|---|---|
| 写入路径符号链接逃逸 | 新增 `path-containment.ts`：`resolveRealTarget` + `isInsideRealRoot`（`path.relative` 判定），读写统一走 `assertInsideRoot` | E7a 通过；`pwned.ts` 未落盘 |
| 方法映射缺失 | 补齐 `browser.*`/`browser.download`/`browser.savePage`/`worktree.createManaged`/`terminalArtifact.*`/`agentProvider.*`，并修正导出规则必须排在 `browser.` 前缀之前 | contract.test + design §7.3 |
| 撤销与绑定缺口 | `setRevocations` 同时处理项目/用户/jti；`admit()` 增加 `declaredDevicePubKey` 绑定断言、`workspaceRoot` 必须位于 `projectRoot` 下；jti 集合按 TTL 清理 | E7b 通过（他人设备 401，原设备 101） |
| `tlsFingerprint` 与版本门禁 | `/connect` 返回 `host.tlsFingerprint`；`clientVersion` 低于 1.5.0 返回 426 `VERSION_UNSUPPORTED` | E7c 通过 |
| failoverBudget | 客户端升级失败后重新申请凭证重试，默认 1 次 | `cloud-client.ts` |
| `worktree.createManaged` | 运行时实现：`nestWorkspaces=false`、路径必须在 `workspaceRoot` 下、幂等键 | E7d 通过 |
| tasks 缺项 | 新增 T301a / T301b / T308a；T303 改为接入容器化校验 | tasks.md |
| browser 权限 | 加入 `Permission` 类型、权限图、ACL 说明、FR-9.3 矩阵、凭据示例 | design §7.3、requirements FR-9.3 |
| 外网 allowlist | 补 `GET /v1/projects/{id}/workspaces`、`POST /v1/workspaces/{id}/close` | design §5.1 |
| 图表 | 图 1/2/3 补路由同步 mTLS 连线；图 3 出站放行 8443 | diagrams.html |
| AC 话术 | AC-21 改为仅 HTTP 401 + `x-orca-reject`；AC-27/28 改为 RPC 错误码 | requirements |
| 一期出口 | 统一为 AC-01 ~ AC-32 | requirements §9、tasks M4 |
| AC 语义归属 | FR-1.7→AC-12、FR-3.3→AC-27 单列 | design §21 |
| 容量与缓存口径 | 明确 3 份 = 主 + 备 + 备份（含索引 20%）；中继缓存写刷新 60s / 硬上限 300s | design §15.2、§13.3 |

## 测试结果

```
node --test test/contract.test.ts            7 pass / 0 fail
node --test test/e2e/platform.e2e.test.ts   14 pass / 0 fail
```

新增 E7a（符号链接逃逸）、E7b（设备移植）、E7c（版本门禁）、E7d（托管工作区）。

待第 4 轮复核。
