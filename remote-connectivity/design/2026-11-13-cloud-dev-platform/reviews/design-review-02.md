# 设计评审 02（v1.2 复核）

> 日期：2026-11-13
> 范围：requirements.md、design.md、diagrams.html、tasks.md（v1.2）
> 评审人：独立评审子代理（只读）
> 结论：**REJECTED**（1 个新 BLOCKER，5 个新 MAJOR，10 个 MINOR）

## 复核结果

| 原编号                    | 结论    | 说明                                                          |
| ------------------------- | ------- | ------------------------------------------------------------- |
| B1 凭证一次性与多端点探测 | CLOSED  | §6.1 生命周期表、§6.4、FR-5.2/5.4、AC-20、T205/T208 一致      |
| B2 托管准入契约           | CLOSED  | §6.6 单一契约、`/connect` 返回 E2EE 公钥、无残留 managed 消息 |
| M1 中继路由同步           | PARTIAL | 正文已改，图表仍有「不依赖平台」与 8443 缺失                  |
| M2 撤销前置条件           | CLOSED  | AC 已补前提；Access Token 改为会话纪元                        |
| M3 信任根                 | CLOSED  | §14.2 声明 TOFU 与平台为信任根                                |
| M4 方法级权限             | PARTIAL | 缺 browser.* 与完整导出方法清单                               |
| M5 工作区隔离             | PARTIAL | 凭证绑定 workspaceRoot，但 `worktree.create` 无法按该路径创建 |
| M6 下载边界               | CLOSED  | 能力矩阵区分可强制/不可强制                                   |
| M7 外泄路径               | CLOSED  | 补齐 git push、包发布、Agent 联网等                           |
| M8 审计定序               | CLOSED  | 单写入序列 + 并发用例进 AC                                    |
| M9 外网访问               | PARTIAL | §5.1 通配与 §12.1 外网列冲突                                  |
| M10 接口/模型缺口         | CLOSED  | 归档、设备、JWKS、分页等已补                                  |
| M11 错误码                | CLOSED  | 分层错误码；4409 单一含义                                     |
| M12 多平台开发机          | CLOSED  | §18 + T501–T503                                               |
| M13 任务拆分              | CLOSED  | 里程碑重排、估算修订                                          |

## 新发现

| 级别      | 问题                                                                                                                                                         | 处理                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| BLOCKER   | `worktree.create` 无路径参数，实际路径 = `workspaceDir/repoName/sanitized`；默认 `~/orca/workspaces` 落在凭证 `workspaceRoot` 之外，策略网关会拒绝全部写操作 | 新增 `worktree.createManaged`（显式 `workspaceRoot`、`nestWorkspaces=false`、幂等键），见 design §8.3 |
| MAJOR     | 图表仍写「不依赖平台」、未放行平台 8443                                                                                                                      | 已改图 2/图 3                                                                                         |
| MAJOR     | §5.1 外网通配 `GET/POST /v1/projects/*` 会放行授权与策略接口                                                                                                 | 改为逐条精确 allowlist                                                                                |
| MAJOR     | 方法映射缺 `browser.*` 与全部导出方法                                                                                                                        | 已补 `browser` 权限与 5 个导出方法                                                                    |
| MAJOR     | 图 4 仍是 GET、旧凭证重连语义、缺 E2EE 公钥                                                                                                                  | 已改 POST、无凭证预检、重连必须重申请                                                                 |
| MAJOR     | §21 AC 映射多处指错                                                                                                                                          | 已按 requirements 8.1/8.2 重排                                                                        |
| MINOR ×10 | 状态机缺重试分支、AC 引用错误、`device`/`deviceId` 不一致、容量口径、审计副本、链接、AC-19 无任务、TTL 语义、升级期拒绝语义、Redis 前提                      | 全部修复                                                                                              |

## 后续

第 3 轮复核确认闭环情况，并校验实现代码与文档一致。
