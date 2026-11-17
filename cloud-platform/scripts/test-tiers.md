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
- 用途：长跑（L4/T1/冒烟）必须带监控；出现 node 进程数或 RSS 异常增长即判资源问题、先停再查。

## 测试进程生命周期（2026-11-17 用户指令）

- **只处理本项目进程**：清理器 `cloud-platform/scripts/cleanup-test-processes.mjs` 仅匹配本项目路径与测试临时目录（`/tmp/orca-*`、`/private/tmp/{u*,w*,c6,gate,smoke,resmon}-*`、本仓 `node_modules/.pnpm/electron*`），**保留** `~/orca-local-env` 的 supervisor/forwarder/relay 与 30 分钟内启动的在途测试进程。
- **默认演练、显式执行**：默认 dry-run 打印 `would kill`；`--yes` 才 TERM→1.5s→KILL，并把报告写入 `evidence/process-cleanup/process-cleanup.jsonl`。
- **自动前置**：`run-test-tier.mjs` 每次运行前自动清理>30 分钟的本项目测试残留，避免残留进程污染后续结果。
- **收尾责任**：任何 harness/驱动必须按 PID 清理自己派生的进程（禁用宽域 `pkill`），全量/长跑结束由调用方再跑一次清理器校验 `matched=0`。
