# 环境门控测试套件清单

> 2026-11-17 复盘固化（协议 §2-67）。普通回归批中这些套件**静默跳过**，不得计入通过面。
> 新增 `runIf(...env...)` 门控时，同批在本表登记；周期执行挂在 L4 / 发版前清单。

| 套件 | 门控条件（解锁变量） | 覆盖内容 | 备注 |
| --- | --- | --- | --- |
| `src/renderer/src/web/web-runtime-direct-proxy-live.integration.test.ts` | `ORCA_REMOTE_ACCESS_PAIRING_INPUT` + `ORCA_REMOTE_ACCESS_PROXY_ENDPOINT` 均有值 | 直连代理 live 集成（3 例） | 回归批 A 中 3 skip 即此；默认环境不可运行 |
| `src/relay/skill-upload-multi-relay.integration.test.ts` | `ORCA_SKILL_UPLOAD_LEGACY_RELAY_ENTRY` | 多中继 skill 上传 legacy 入口 | |
| `src/main/git/command-runner/git-admission-storm-measurement.test.ts` | `ORCA_GIT_ADMISSION_STORM_MEASUREMENT=1` | git 准入风暴测量 | 测量类，非功能门 |
| `src/main/codex/codex-index-heal-binary-contract.test.ts` | `ORCA_CODEX_CONTRACT_REQUIRED=1` | codex 无二进制时的契约负控 | 需真实 codex 二进制缺失场景 |
| `src/main/codex/codex-hook-file-entry-binary-contract.test.ts` | `ORCA_CODEX_HOOK_CONTRACT_REQUIRED=1` | codex hook 文件入口契约 | 同上 |
| `src/main/pty/codex-no-daemon-binary-contract.test.ts` | `ORCA_CODEX_NO_DAEMON_CONTRACT_REQUIRED=1` | codex --no-daemon 契约 | 同上 |

平台侧另有按需门控：`ORCA_REAL_CLAUDE_CLI_TEST=1`（`src/main/claude/claude-structured-real-cli*.test.ts`，AGENTS.md 已列为改动后必跑）。

## 运行时版本门（2026-11-17 L4 判例）

| 门 | 要求 | 判例 |
| --- | --- | --- |
| Node 版本（跑 `src/main` 全量 / 台账持久化簇） | **Node ≥ 24.16.0**，或直接使用 Electron 内置 Node（43.7.5 → v24.21.0，`ELECTRON_RUN_AS_NODE=1`） | Node v24.5.0 的 `node:sqlite` 在 TEXT 中遇 NUL 截断，`agentSessionOperationKey`（`\u0000` 分隔）重开后整行丢失 → 34 例假红；Electron Node 下 113/113 绿（`evidence/l4-ledger-node-matrix-20261117-110016/`） |
| 后台启动 | 任何 Electron/宿主相关测试与 L4 main 全量：`ORCA_BACKGROUND_LAUNCH=1` | 缺少时 browser-manager 两文件 41 例硬断言失败 |

可选加固（未实施）：持久化键改 JSON 编码 + `engines.node` 收紧至 `>=24.16`（需迁移旧行，列为 P3）。
