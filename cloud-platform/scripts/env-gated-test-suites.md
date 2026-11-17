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
