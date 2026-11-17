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
| Node 版本（跑 `src/main` 全量 / 台账持久化簇） | **Node ≥ 24.16.0**（可用 `npx -y node@24.16.0 node_modules/vitest/vitest.mjs ...`）；**不要**用 Electron 内置 Node 跑含证书/EC 的套件 | Node v24.5.0 的 `node:sqlite` 在 TEXT 中遇 NUL 截断，`agentSessionOperationKey`（`\u0000` 分隔）重开后整行丢失 → 34 例假红；Electron Node 下台账簇 113/113 绿（`evidence/l4-ledger-node-matrix-20261117-110016/`），但 Electron 的 BoringSSL 不支持部分 EC 运算（`elliptic curve routines: DECODE_ERROR`），会让 ws-transport/profile-state 等批出现假红（2026-11-17 12:2x 判例）；仅在**只涉 sqlite 且无 crypto** 的定向簇可用 Electron Node |
| 后台启动 | 任何 Electron/宿主相关测试与 L4 main 全量：`ORCA_BACKGROUND_LAUNCH=1` | 缺少时 browser-manager 两文件 41 例硬断言失败 |
| Node 发行形态 | 需要 `include/node` 的测试（`ssh-relay-node-headers`）须用**官方 Node 发行包**，`npx node@…` 不含 headers | npx 包缺 `include/node` → `expected '' to be '<prefix>'`（2 例）；官方 v24.16.0 包定向复跑 8/8 通过 |

可选加固（未实施）：持久化键改 JSON 编码 + `engines.node` 收紧至 `>=24.16`（需迁移旧行，列为 P3）。

## 并发与资源门（2026-11-17 用户指令）

| 场景 | 规则 |
| --- | --- |
| 本机全量（vitest） | 默认 **2 workers**（`config/vitest.config.ts` 自动生效）；需要更少/更多时用 `ORCA_TEST_MAX_WORKERS=N` 覆盖；CI（`CI=1`）保持 vitest 默认 |
| 分层 runner（`run-test-tier`） | **强制 Node ≥24.16**：低于时 exit 3 并给出 `npx -y node@24.16.0 …` 命令；`ORCA_TEST_NODE_AUTO=1` 自动重执行；运行时版本打印在首行 | 判例 U179：node 24.5 下 T2 出现 17 例 sqlite 假红 |
| 长跑采样 | runner 启动**独立子进程采样器**（`resource-sampler.mjs`）；不再依赖主进程事件循环（曾被 `spawnSync` 阻塞导致 samples=0） | 判例 U179 |
| 任意全量段 | 串行排队（§2-73），不得两段并行；并行只允许「一个全量 + 轻量单测」 |
| Electron/e2e | `electron-headless` 项目 + `ORCA_BACKGROUND_LAUNCH=1 ORCA_SUPPRESS_DIALOGS=1`；启动整体超时 120s，超时强制关闭（§2-74） |
