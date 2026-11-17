# 测试分层（避免每次全量）

> 2026-11-17 用户指令固化：减少并发单测/集成测试、降低资源占用、先测关键业务、避免每次全量。

## 分层与命令

| 层            | 何时用                                                | 命令                                                       | 并发                                                   |
| ------------- | ----------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| T0 冒烟三连   | **任何改动/任何更大范围测试之前**（§2-75）            | `node cloud-platform/scripts/smoke/desktop-smoke-gate.mjs` | 串行，`electron-headless`                              |
| T1 关键业务   | 提交前/合并前；覆盖会话、终端、持久化、平台权限与审计 | `node cloud-platform/scripts/run-test-tier.mjs critical`   | vitest 默认 2 workers；平台 e2e `--test-concurrency=1` |
| T2 改动面     | 日常迭代（默认选项）                                  | `node cloud-platform/scripts/run-test-tier.mjs changed`    | 同 T1，仅跑受影响目录                                  |
| T3 全量（L4） | **发版前**或明确要求                                  | 见 PROGRESS 的 L4 记录（真 Node ≥24.16，串行分段）         | 单段串行，禁止两段并行（§2-73）                        |

npm 快捷入口：`pnpm test:tier:smoke` / `pnpm test:tier:critical` / `pnpm test:tier:changed`（均自动带资源监控与运行前进程清理）。

## 运行时门（2026-11-17 U179）

- `run-test-tier.mjs` 启动任何 tier 前先校验执行它的 Node：**必须 ≥ 24.16.0**（真 Node，非 Electron）。
- Node < 24.16 时**拒绝运行**（exit 3，不 chdir/不清理/不启动监控），打印可用命令：
  `npx -y node@24.16.0 cloud-platform/scripts/run-test-tier.mjs <tier>`。
- 设 `ORCA_TEST_NODE_AUTO=1` 时自动用 `npx -y node@24.16.0` 重新执行自身并透传参数；npx 会把 24.16 的 `node` 放到 PATH 前面，vitest 的 `#!/usr/bin/env node` 也随之落到正确版本。
- 原因：Node < 24.16 的 `node:sqlite` 在 TEXT 的 NUL 处截断，制造台账簇等环境假红（见 `env-gated-test-suites.md`）。每次运行都会打印实际版本：`[runtime] node <version> (<execPath>)`。
- 不要用 Electron 内置 Node 跑含证书/EC 的套件（BoringSSL `DECODE_ERROR`）。

## 证据校验（§3a 机检）

每次长跑/验收后：
`node cloud-platform/scripts/validate-evidence.mjs <evidence-dir> --max-age-hours=24 --check-generated-at`
须 PASS（目录内 `summary.json` 或 `results.json` 有效且非空、JSON 可解析、未过期，且 `summary.json.generatedAt` 存在、可解析、在窗口内）。长跑代理必须同时写出 `summary.json`（任务、verdict、关键值、产物 sha、`generatedAt`），避免只留文本产物。

## 原则

1. **默认只跑 T2**：`git diff HEAD` 与 `origin/main...HEAD` 的文件映射到目录级测试；没有映射时明确输出「无受影响测试」。
2. **T1 优先关键业务**：会话/布局同步、终端传输、profile-state 持久化、平台项目/权限/审计/撤销/中继新鲜度；不在 T1 的用例留给 T2/T3。
3. **api 改动的 T2 口径（2026-11-17 收敛）**：`cloud-platform/apps/api/` 不再映射整棵 `cloud-platform/test/e2e`，而是只跑 T1 的关键业务集（`CRITICAL_CLOUD_E2E`：项目归档、策略版本冲突、web 下载策略、web 设置/项目策略、撤销、主机授权、中继路由新鲜度）。日常 api 小改默认走这一口径；若改动涉及鉴权/审计/中继等关键路径、拿不准覆盖面，或改动横跨多个 api 模块，显式补跑 `run-test-tier.mjs critical`（T1），T2 中出现 api 改动时也会打印该提示。只有发版前或明确要求才跑 T3 全量。
4. **不重复测试**：同一改动连续多次运行同一层视为浪费；T0/T1 通过后，除非改动文件集合变化，否则不再重复。
5. **并发上限**：本机 vitest 默认 2 workers（`ORCA_TEST_MAX_WORKERS` 可覆盖，CI 保持默认）；平台 `node --test` 固定 `--test-concurrency=1`；Electron/e2e 一律 `electron-headless` + 后台/抑制变量。
6. **提交前标准（2026-11-17 用户指令）**：只证明本次修改的功能正常——跑受影响目录/spec（T2）、必要时 T1 相关项；**不跑全量、不跑无关套件**。桌面/渲染改动另加冒烟三连。全量（T3）仅发版前或明确要求。
7. **全量不是默认动作**：`full` 层被脚本显式拒绝，须走发版前 L4 流程并记录证据。

## 资源监控（2026-11-17 新增）

```bash
node cloud-platform/scripts/monitor-system-resources.mjs \
  --interval=5 --out=cloud-platform/evidence/resource-monitor-<ts> \
  --max-node=24 --max-rss-gb=12 --max-load=0 -- <要运行的测试命令>
```

- 采样内容：进程数、node/Electron 进程数、总 RSS、loadavg、Top5 内存进程；每 5s 一行写入 `system-resources.jsonl`。
- 超阈值打印 `[resource-watch]` 警告；结束写 `system-resources-summary.json`（peak 值）。
- **tier runner 用独立子进程采样**：`run-test-tier.mjs` 启动 `resource-sampler.mjs` 子进程，结束后 SIGTERM 并等待 summary。采样不依赖 runner 事件循环，因此 `spawnSync` 阻塞期间仍持续落盘（U179 修复；旧实现 `samples=0`）。
- 用途：长跑（L4/T1/冒烟）必须带监控；出现 node 进程数或 RSS 异常增长即判资源问题、先停再查。

## 证据完整性（2026-11-17）

- 证据目录须过 `node cloud-platform/scripts/validate-evidence.mjs <evidence-dir> [--require=run.log,summary.json] [--max-age-hours=24] [--check-generated-at]`（PASS 才可引用；自测：`pnpm test:evidence`）。

## 测试进程生命周期（2026-11-17 用户指令）

- **只处理本项目进程**：清理器 `cloud-platform/scripts/cleanup-test-processes.mjs` 仅匹配本项目路径与测试临时目录（`/tmp/orca-*`、`/private/tmp/{u*,w*,c6,gate,smoke,resmon}-*`、本仓 `node_modules/.pnpm/electron*`），**保留** `~/orca-local-env` 的 supervisor/forwarder/relay 与 30 分钟内启动的在途测试进程。
- **默认演练、显式执行**：默认 dry-run 打印 `would kill`；`--yes` 才 TERM→1.5s→KILL，并把报告写入 `evidence/process-cleanup/process-cleanup.jsonl`。
- **自动前置**：`run-test-tier.mjs` 每次运行前自动清理>30 分钟的本项目测试残留，避免残留进程污染后续结果。
- **收尾责任**：任何 harness/驱动必须按 PID 清理自己派生的进程（禁用宽域 `pkill`），全量/长跑结束由调用方再跑一次清理器校验 `matched=0`。

> 注意（2026-11-17）：校验器的 freshness 取目录内最新 mtime，**回填/重写 `summary.json` 会刷新它**；审计历史证据时应同时核对 `summary.json` 的 `generatedAt` 与原始产物 mtime，不能只看 PASS。
>
> 因此审计任何可能被回填过的目录时必须加 `--check-generated-at`：它按 `summary.json.generatedAt`（而非 mtime）判断新鲜度，缺失/不可解析/超窗分别报 `summary-generated-at-missing` / `summary-generated-at-invalid` / `summary-generated-at-stale`；不传该选项时行为与旧版完全一致。对已回填目录（如 2026-11-17 补写 `summary.json` 的 `u106-restart-window-20261117-132713`、`desktop-smoke-1794889582`、`final-build-prod-20261117-131941`、`resource-monitor-changed-1794895271990`），`generatedAt` 记录的是回填写入时间（`2026-11-17T06:54:21Z`），只能证明「回填时点的产物快照」，**不证明原始 run 的时间**；引用时须与目录内原始产物 mtime/内容一并说明。

## relay 容器 e2e 前提与 skip 语义（2026-11-17 U183 R13a）

夹具：`cloud-platform/test/e2e/helpers/relay-container-harness.ts`；自测：`cloud-platform/test/e2e/relay-container-harness.e2e.test.ts`（`node --test test/e2e/relay-container-harness.e2e.test.ts`）。

- **前提**：本机 Docker daemon 可用；本地缓存 `jlc-deb12:rust`（Debian 12 amd64，含 bash/curl/openssl，**无 Node**）。夹具**不拉镜像**（Docker Hub 不可达）。
- **skip 语义**：Docker CLI/daemon 不可用、镜像缺失、镜像缺 bash/curl/openssl、工具探测超时 → `startContainerHarness()` 返回 `available=false` 与 `skipReason`，**不抛错、不计失败**；用例用 `t.skip(skipReason)` 显式跳过。`docker run` 等其它启动错误仍抛错（环境坏了要红）。
- **容器**：每次唯一名 `relay-e2e-<rand>`，`--rm`，注入临时 HOME（容器内 `/tmp/orca-relay-e2e-home`，`harness.homeDir` 为实测值）；Linux 自动加 `--add-host=host.docker.internal:host-gateway`，macOS 用 Docker Desktop/OrbStack 自带解析。
- **平台可达**：夹具在本机 `0.0.0.0:<随机端口>` 起 TCP forwarder（复用 `startTcpDelayHop`，延迟 0），容器内用 `getContainerPlatformUrl()` = `http://host.docker.internal:<forwarderPort>`；`checkPlatformReachable(path = '/health')` 用容器内 curl 探测。平台须由调用方先启动。
- **Node 缺失**：记录为 `capabilities.node=false`，不当作产品失败。依赖 Node 的 R13c/R14 用例据此 skip；**R14a 的 N4（无 Node → 64）是负向断言，必须执行，不能 skip**。
- **收尾**：`stop()` 只 `docker rm -f <唯一名>` 并关闭自起 forwarder；进程退出钩子兜底清理本进程创建的容器。**禁止宽域 `pkill`**。

## 证据结构（2026-11-17 U183 R13b）

运行器：`cloud-platform/test/e2e/helpers/relay-container-runner.ts`；自测：`cloud-platform/test/e2e/relay-container-runner.e2e.test.ts`（mock harness，不启容器）。

- **目录**：`cloud-platform/evidence/u183-container-<ts>/`（`<ts>` = UTC `YYYYMMDDTHHMMSSZ`，由 `createRelayEvidenceDir()` 生成）。
- **文件**：
  - `summary.json`：`task`、`generatedAt`（ISO，必需，供 `--check-generated-at`）、`verdict`、`skipReason`、每步 `{name, exitCode, classification, skipped}`、`validation` 结果。
  - `results.json`：每步完整结果 + `stdoutFile`/`stderrFile`/字节数/`durationMs`/`timedOut`。
  - `<NN>-<step>.stdout.log` / `.stderr.log`：原始流，不做脱敏（调用方负责不写入令牌）。
  - `validate-evidence.log`：自动校验的原始输出。
- **verdict**：`pass`（每步 exitCode=0）/ `fail`（任一步非 0）/ `null`（harness 不可用或任一步 skipped；此时 `skipReason` 必填）。
- **退出码分类**（`classifyRelayExitCode`）：`0 ok`、`64 usage`、`65 unavailable`、`66 checksum`、`67 manifest`、`68 platform-unreachable`、`78 config`、其余 `other`（含超时 124 与启动失败 70）。
- **skip 门禁**：`runRelayInstallInContainer()` 在 `harness.available=false` 时不执行命令，返回 `exitCode=null / classification=skipped`；`collectRelayEvidence()` 据此写 `verdict=null`，不抛错、不计失败。
- **自动校验**：`collectRelayEvidence()` 写盘后自动跑 `validate-evidence.mjs <dir> --check-generated-at --json`，结果写入 `summary.validation` 与日志；失败只 `console.warn`，不阻断证据落盘。
