# U183 设计令 · 中继安装向导必须真正安装并上线中继

- 日期：2026-11-17
- 性质：设计（只设计，未改产品代码）
- 输入：`defect-ledger.md` U183、`deployment-real-link.md` §0/§2/§3、`u181-host-mode-design.md` v3、`cloud-platform/apps/api/src/server.ts` 的 `relayInstallScript`、`cloud-platform/apps/relay/src/relay.ts`、`cloud-platform/test/e2e/install-wizard.e2e.test.ts`
- 结论：**方案 A——平台下发内容寻址的 relay 源码包（tarball + 内嵌 sha256）**；脚本完成下载、校验、解包、激活、装服务，并以平台 `/v1/internal/relays` 的 `online=true` 自证。仓库 clone（C）仅保留为离线/开发逃生口；随 Orca 包分发（B）与容器化（D）本次不采用。
- 复核基线：当前工作树（含未提交的 U182 批 2）。行号会漂移，引用以「文件:符号」为准，行号为撰写时位置。

---

## 0. 结论摘要

| 项 | 结论 |
| --- | --- |
| 分发形态 | 平台构建时生成**纯源码 tarball**，按 sha256 内容寻址：`/install/relay-bundle/<sha256>.tgz` |
| 校验 | sha256 在管理员生成的 `relay.sh` 中**内嵌并钉死**；下载后再比对，不信任响应体 |
| 安装位置 | 默认 `$HOME/.orca-cloud/relay`（无 sudo）；`ORCA_RELAY_ROOT` 可指向 `/opt/orca-cloud/relay` |
| 运行时 | 目标机需 Node ≥22.18（`cloud-platform/package.json:14`）；包内无需 `node_modules` |
| 激活 | 解包到 `releases/<sha>/`，原子切换 `current` 符号链接；保留 N-1 供回滚 |
| 守护 | 有 user systemd 则装 unit 并 `enable --now`；否则共享 wrapper + nohup + pid |
| 自证 | 轮询 `/v1/internal/relays`，匹配本机 `RELAY_ID` 且 `online=true`；不看日志字符串 |
| 幂等 | 重跑复用同 sha 的释放目录；升级切换新 sha；失败自动回滚上一版本 |
| 与 U181 | 共用预检、健康检查、systemd 探测、原子 env 写入、启动/轮询骨架；relay 额外实现 `relay.ts --preflight` |
| 拆分 | 14 令，全部 ≤20 分钟 |

### 0.1 一个必须先说清的命名陷阱

Orca 安装包里的 `out/relay/`（`config/electron-builder.config.cjs:102-127`）是**桌面 SSH 中继资产**（`relay.js`、`relay-watcher.js`、WSL relay 等），与云平台的 `cloud-platform/apps/relay` **不是同一个东西**。U183 不得复用 `out/relay`，也不得把云中继塞进该目录。

---

## 1. 现状与缺口

### 1.1 脚本实际做了什么

`server.ts:451` `relayInstallScript()` 生成的脚本只有四段：

| 行 | 动作 | 事实 |
| --- | --- | --- |
| `server.ts:460-466` | 检查 `node` | 仅 `command -v node`，不校验版本；注释自己写明「本脚本不安装中继运行时」 |
| `server.ts:467-472` | 检查中继入口 | 要求 `$ORCA_RELAY_ROOT/cloud-platform/apps/relay/src/relay.ts` 已存在；不存在即 exit 1 |
| `server.ts:474-484` | 写 `relay.env` | `ORCA_CLOUD_API_URL`、`ORCA_CLOUD_INTERNAL_TOKEN`、`PORT`、`RELAY_PUBLIC_HOST` |
| `server.ts:486-496` | 平台健康检查 | 有界、不跟重定向、只认 2xx（U182） |
| `server.ts:498-536` | **只打印** | 打印 `node relay.ts`、systemd unit 文本或 nohup 命令，**不执行** |

全脚本没有 `curl` 下载（`curl` 只用于 `/health`）、没有 `tar`、没有 `sha256`、没有 `cp/install`、没有 `systemctl enable`。缺陷台账 U183 的「无下载、无安装、无服务创建」与代码一致。

### 1.2 目标机前提与代码事实

1. **入口是 TypeScript，且跨目录相对导入**：`relay.ts:10` `import { mtlsFetch } from '../../../packages/contract/src/internal-fetch.ts'`，`relay.ts:11` `./sni.ts`。因此「只拷 relay.ts」跑不起来；释放目录必须保留 `apps/relay/src` 与 `packages/contract/src` 的相对层级。
2. **没有 npm 依赖**：`cloud-platform/package.json` 没有 `dependencies`，`internal-fetch.ts` 只 import `node:fs`/`node:https`。包不需要 `pnpm install`，也不需要 `node_modules`。
3. **Node 版本是硬前提**：`cloud-platform/package.json:14` `"node": ">=22.18"`，即默认启用 type stripping 的版本；`package.json:11` 的开发命令就是 `node apps/relay/src/relay.ts`。低于 22.18 会在解析 `.ts` 时失败。
4. **注册即自证**：中继 listen 后先 `refresh()`（`relay.ts:660-668`），成功后 `announce()`（`relay.ts:340-344,348-377`）向 `POST /v1/internal/relay-endpoint` 报到；平台按 30s 窗口判 `online`（`relay-nodes.ts:7`、`server.ts:4581-4592`）。
5. **默认 id 会撞车**：未显式给 `id` 时平台用 `relay:${port}`（`relay-nodes.ts:58`），而同端口的多台中继会互相覆盖。脚本要做自证，必须能唯一识别本机中继。
6. **当前默认安装根不可写风险**：脚本默认 `/opt/orca-cloud`，却安装 **user** systemd unit；普通用户通常写不了 `/opt`。这是「跑起来看似成功、实际要 sudo」的隐性前提。

### 1.3 验收缺口

`deployment-real-link.md:61` 把「Node ≥22.18 + 仓库代码（或镜像）」列为中继机前置，`:72` 却承诺管理台一键命令。现状等于把「把仓库放到 `/opt/orca-cloud`」这件未写入任何步骤的事留给操作者。U182 容器回归（`evidence/u182-b2-regress-20261117T170856/`）在预检阶段即退出，没有创建任何中继服务。

---

## 2. 方案对比与推荐

### 2.1 候选

| 案 | 形态 |
| --- | --- |
| **A** | **平台下发源码 tarball**：脚本从平台下载 `.tgz`，校验 sha256，解包到安装根，装服务 |
| B | 随 Orca 安装包分发：Orca deb/rpm/AppImage 内含云中继，脚本只启用服务 |
| C | 仓库 clone/依赖已装：脚本要求 `$ORCA_RELAY_ROOT` 已有仓库（或自行 `git clone` + `pnpm install`） |
| D | 容器化：平台下发/引用镜像，目标机用 Docker/Podman 运行中继 |

### 2.2 评估

| 维度 | A 平台 tarball | B 随 Orca 包 | C 仓库 clone | D 容器镜像 |
| --- | --- | --- | --- | --- |
| 目标机前提 | bash/curl/tar/sha256sum + Node ≥22.18 + 平台可达 | 已装 Orca 包（含 pinned Node）+ 包版本匹配 | git（若脚本 clone）+ pnpm + 仓库网络 + Node | Docker/Podman + 镜像仓库访问 |
| 离线可用 | **好**：包由平台自己提供，只需平台可达；真正气隙可手工携带 tgz | **最好**：随包 | **差**：依赖代码托管 | **中**：需镜像仓库/`save`+`load` |
| 升级路径 | 重新生成命令/重跑；平台版本与中继源码天然一致；可保留 N-1 | 跟随 Orca 发版；中继 API 属平台侧，版本错位风险高 | `git pull`，不可复现 | 换镜像 tag，回滚容易 |
| 安全性 | sha256 在脚本中钉死，脚本管理员门禁 + `no-store`；包无密钥 | 包签名最强（deb/rpm） | 无完整性钉死，分支漂移 | 可镜像签名，但多一个高权限守护进程 |
| 与 U181 host 对称性 | **高**：同一套预检/健康检查/服务安装/自证骨架 | 高（都用 Orca 包），但 relay 没有装整套 Orca 的理由 | 低 | 低（host 是进程，relay 是容器） |
| 测试成本 | 中：包构建 + 下载端点 + 容器 e2e | 高：打包、多架构、发版耦合 | 低实现、高验收（不可复现） | 高：目标机未必有容器运行时 |
| 结论 | **推荐** | 否 | 仅逃生口 | 否 |

### 2.3 推荐：A（默认），C 作为显式逃生口

否决理由：

- **B**：云中继与平台 API 同仓同版本演进（`/v1/internal/relay-routes`、`relay-endpoint`），把它绑到 Orca 客户端发版周期会制造跨产品版本错位；且中继机通常不装桌面 Orca。若未来 Orca 包提供 `cloud-relay` 组件再重评。
- **C**：当前脚本已经是 C 的「要求已 checkout」形态，U183 要修的就是它。脚本**不**执行 `git clone`/`pnpm install`——那会引入代码托管可达性与不可复现构建。
- **D**：`deployment-real-link.md` 的中继机前提没有容器运行时；为一次安装引入 Docker 与其权限面不划算。

保留的逃生口：`ORCA_RELAY_BUNDLE=/path/to/relay-bundle.tgz`（离线/气隙，仍校验内嵌 sha）与 `ORCA_RELAY_ROOT` 指向既有解包目录（开发机）。二者都**不下载**。

### 2.4 包契约

构建产物（新增 `cloud-platform/scripts/build-relay-bundle.mjs`）：

```
relay-bundle-<sha256>.tgz
└── apps/relay/src/relay.ts
    apps/relay/src/sni.ts
    packages/contract/src/internal-fetch.ts
    VERSION                # {"version":"0.1.0","sha256":"<bundle sha>","builtAt":"..."}
```

- 只含上述 4 个文件；不含 `node_modules`、`.git`、证书、env。包内**无任何密钥**（内部令牌只在管理员生成的 `relay.sh` 和 `0600` 的 `relay.env` 中）。
- `sha256` 对 tarball 原始字节计算；文件名与内容寻址 URL 都用它。构建测试断言文件清单与重复构建的 sha 稳定（tar 元数据固定 mtime/uid/gid）。
- 平台端点：`GET /install/relay-bundle/<sha256>.tgz`，内容寻址、可公开（包无密钥，sha 已由脚本钉死），响应 `cache-control: public, max-age=31536000, immutable`。生成 `relay.sh` 时若磁盘没有对应包，管理台请求直接 `503 RELAY_BUNDLE_UNAVAILABLE`，**不生成注定失败的脚本**。
- 脚本内嵌：`ORCA_RELAY_BUNDLE_SHA256`、`ORCA_RELAY_BUNDLE_URL`、`ORCA_RELAY_BUNDLE_VERSION`。
- 运行时契约不变：`node <root>/apps/relay/src/relay.ts`，env 仍读 `ORCA_CLOUD_API_URL` / `ORCA_CLOUD_INTERNAL_TOKEN` / `PORT` / `RELAY_PUBLIC_HOST`（`relay.ts:195`、`:693-709`）。新增 `RELAY_ID`（见 §8 R3）。

---

## 3. 安装时序

脚本按以下顺序执行；**任何一步失败都不启动服务**，并在 stderr 给出稳定码。

| # | 步骤 | 细节 | 失败码 |
| --- | --- | --- | --- |
| 1 | 预检工具 | `bash`、`curl`、`tar`、`sha256sum`（macOS 回退 `shasum -a 256`）、`node` 版本 ≥22.18；安装根可写（默认 `$HOME/.orca-cloud/relay`） | 64 / 78 |
| 2 | 平台健康 | `GET <platform>/health`，5s 连接 / 10s 总超时，不跟重定向，只认 2xx | 68 |
| 3 | 取得包 | 默认 `curl -fsS --proto '=https' --tlsv1.2`（HTTP 平台测试环境显式放行）到 `$ROOT/downloads/<sha>.tgz.part`；已存在且校验通过则跳过。支持 `ORCA_RELAY_BUNDLE` 本地文件 | 65 |
| 4 | 校验 | 对 tarball 算 sha256，与脚本内嵌值逐字节比对；不匹配删除临时文件 | 66 |
| 5 | 安全检查 | `tar -tzf` 列出条目，拒绝绝对路径、`..`、符号链接逃逸；只允许 `apps/`、`packages/`、`VERSION` | 67 |
| 6 | 解包 | 解到 `$ROOT/releases/<sha>.tmp-$$`，校验 3 个必需文件存在，再原子 `mv` 为 `$ROOT/releases/<sha>` | 67 |
| 7 | 运行时预检 | `node <release>/apps/relay/src/relay.ts --preflight`（R3 新增）：只解析 env、校验 Node/模块图，不 listen、不发 HTTP、不注册 | 64 / 78 |
| 8 | 激活 | `ln -sfn` 到临时链接后 `rename` 为 `$ROOT/current`，指向本次 release；上一版指针写入 `$ROOT/previous` | 67 |
| 9 | 写 env | 临时文件 + `fsync` + `rename`，`0600`；写入 API URL、内部令牌、`PORT`、`RELAY_PUBLIC_HOST`、`RELAY_ID`、可选 `INTERNAL_TLS_*` | 78 |
| 10a | systemd | 探测 user systemd（复用 U182 批 2 的探测）：写 `~/.config/systemd/user/orca-relay.service`，`ExecStart=<node 绝对路径> <root>/current/apps/relay/src/relay.ts`，`WorkingDirectory=<root>/current`，`Restart=on-failure`、`RestartSec=2`；`daemon-reload` + `enable --now`；`loginctl enable-linger` 失败只告警 | 69 |
| 10b | 无 systemd | 写 `$ROOT/run-relay.sh`（显式 `set -a; . relay.env; set +a; exec node …`），`nohup setsid` 启动，写 `relay.pid`；明示不随开机自启 | 69 |
| 11 | 自证 | 记录 `ORCA_INSTALL_STARTED_AT`；每 2s 轮询 `GET /v1/internal/relays`（`x-internal-token`），要求存在 `id == $RELAY_ID`、`online == true`、`lastSeenAt >= 开始时间`；同时 `kill -0` 校验 pid。默认 60s 超时 | 70 |
| 12 | 成功输出 | 打印 relay id、`host:port`、版本、配置文件路径、停止/回滚命令 | 0 |

补充：

- 先 listen 后同步是 relay 既有语义（`relay.ts:658-668`）：平台不可达时进程仍会在 listen 后每 2s 重试（`relay.ts:379-385`）。因此「进程起来了」不等于「上线」，第 11 步必须查平台登记，不能只看 `kill -0`。
- 第 11 步使用内部令牌查询内部接口；令牌来自刚写入的 env，避免在命令行泄漏可改用 `curl -H @-`（从 stdin 读 header）。
- 有 systemd 时 `is-active` 只是辅助证据；最终判据仍是平台 `online`。

---

## 4. 失败码、幂等与升级/回滚

### 4.1 稳定失败码

| 码 | 名称 | 触发 | 可重试 | 副作用 |
| --- | --- | --- | --- | --- |
| 0 | — | 安装并上线 | — | 服务运行 |
| 64 | `relay_runtime_missing` | 缺 curl/tar/sha256sum，`node` 缺失或 <22.18 | 是（补依赖） | 未写安装根（除 downloads 目录） |
| 65 | `relay_bundle_unavailable` | 下载失败/404/平台 5xx/`ORCA_RELAY_BUNDLE` 不存在 | 是 | 无 |
| 66 | `relay_bundle_checksum_mismatch` | sha256 与内嵌值不符 | 是（重新下载） | 删除坏包 |
| 67 | `relay_bundle_unpack_failed` | tar 非法条目、缺文件、激活失败 | 否（换包） | 保留旧 `current` |
| 68 | `relay_platform_unreachable` | `/health` 非 2xx 或超时 | 是 | 无 |
| 69 | `relay_service_install_failed` | unit 写入/启动、wrapper/nohup 失败 | 视原因 | env 已写，服务未就绪 |
| 70 | `relay_not_online_timeout` | 60s 内平台未登记 online | 是（看日志/平台） | 自动回滚（若存在 previous） |
| 75 | `relay_install_busy` | 另一安装进程持锁 | 是 | 无 |
| 78 | `relay_config_invalid` | 安装根不可写、参数/环境冲突、`--preflight` 不过 | 否 | 无 |
| 1 | 未分类 | 兜底 | 视原因 | — |

与 U181 host 的 `0/1/78` 保持同一语义基线；64–70/75 是 relay 安装脚本的细分，便于负向测试精确断言。

### 4.2 幂等

| 场景 | 行为 |
| --- | --- |
| 重跑，同 sha | 命中 `downloads/<sha>.tgz` 与 `releases/<sha>`，跳过下载/解包；原子重写 env；`restart` 服务；`RELAY_ID` 不变 → 平台同一条目刷新，不产生重复节点 |
| 重跑，新 sha | 新 release 解包 → `previous=current` → `current=新` → 重启；旧 release 保留 |
| 并发执行 | `flock`（无则 `mkdir` 锁）在 `$ROOT/.install.lock`；拿不到退出 75 |
| env 已存在 | 不删除、不重置；只覆盖本次受管键；`RELAY_ID` 一旦生成则**保持稳定** |
| 服务已运行 | 先 `stop`/`TERM` 旧 pid，等端口释放再启动；不并存两个中继进程 |
| 平台已有同名 `RELAY_ID` | 注册是 upsert（`relay-nodes.ts:56-67`），覆盖 host/port/lastSeenAt，符合重跑语义 |

### 4.3 升级与回滚

- **升级**由管理员重新生成安装命令并重跑；脚本**不自更新**，中继进程也不轮询新版本。
- 激活前把当前 `current` 目标写入 `$ROOT/previous`。
- 第 11 步超时（70）且 `previous` 存在：原子把 `current` 指回 previous，重启服务，再等 30s；恢复成功则退出 70 并明确打印「已回滚到 `<old sha>`，新版本未上线」。
- 回滚后 env 保持；若新版本引入了必需的新 env 键，回滚版本会忽略未知键，安全。
- 成功输出打印一键回滚命令（把 `current` 切回 `previous` 并重启），供人工使用。
- 保留最近 2 个 release；更旧的由重跑时清理（只删除非 `current`/`previous` 的 `releases/*`）。

---

## 5. 与 host 脚本 / `--host-mode` 的共享部分

U181 的 H9/H10 会重写 `hostInstallScript`。若 U183 另写一套，同一段健康检查、systemd 探测、nohup wrapper 会被两条令反复改。硬约束：**先抽公共片段，再写 relay 特有编排**。

### 5.1 共享模块（新增 `cloud-platform/apps/api/src/install-script-snippets.ts`）

导出供 `hostInstallScript`（`server.ts:292`）与 `relayInstallScript`（`server.ts:451`）拼装的 bash 片段：

| 片段 | 内容 | 谁用 |
| --- | --- | --- |
| `installPreamble()` | `set -euo pipefail`、`umask 077`、`require_command`、版本比较、错误码输出函数 | host + relay |
| `platformHealthCheck()` | U182 的有界、不跟重定向、只认 2xx | host + relay |
| `systemdProbe()` | user bus / systemctl 可用性 / 老 systemd 能力 | host + relay |
| `atomicEnvWrite()` | 临时文件 + `fsync` + `rename` + `0600` | host + relay |
| `userUnitInstall()` | 写 unit、`daemon-reload`、`enable --now`、linger 失败告警 | host + relay（不同 ExecStart） |
| `noSystemdWrapper()` | 显式 source env 的 wrapper + nohup/setsid + pid | host + relay |
| `pollUntil()` | 有界轮询 + 超时输出 + 证据打印 | host 查状态文件；relay 查平台登记 |
| `bundleFetchVerifyUnpack()` | 下载、sha256、tar 安全解包、原子激活 | 仅 relay；若未来 host 也走平台下发则复用 |

### 5.2 对称的部分

- `relay.ts --preflight` 对齐 `orca-ide --host-mode --preflight`：只做本地检查，不消耗/不发送凭据，退出 0/78。
- 两者的 one-liner 都在启动前做平台健康检查、都用服务守护、都以**结构化证据**（host：状态文件；relay：`/v1/internal/relays` JSON）判定成功，不解析日志。
- 退出码语义对齐：78 配置终态、1 可重试、细分码仅用于安装脚本。

### 5.3 明确不共享

- **运行时**：host 用 Orca 包内 `orca-ide`/orcad 与 pinned Node（U181 A2）；relay 用系统 Node + 平台源码包。不要把 relay 塞进 orcad 槽。
- **令牌模型**：host 令牌一次性、注册即焚（`server.ts:3525`）；relay 内部令牌是平台级长期密钥，重跑安全。文案与自证方式因此不同。
- **身份**：host 的身份由注册凭据产生；relay 必须显式 `RELAY_ID`（见 R3），不能继续依赖会撞车的 `relay:<port>`。

### 5.4 依赖顺序

`R12（抽取公共片段）` 必须在 U181 H9a/H10a 与 U183 R4–R11 之前合入，避免两边各写一份。若 U181 尚未开工，R12 可直接从现有两个模板抽取，行为不变。

---

## 6. 测试与验收

### 6.1 单元/集成（无容器）

| 项 | 断言 |
| --- | --- |
| 包构建 | 确定性：同一输入两次构建 sha 相同；文件清单恰为 4 项；无 `node_modules`/`.git`/密钥 |
| 生成器 | 管理员拉取 `/install/relay.sh`：含 `ORCA_RELAY_BUNDLE_SHA256`、`ORCA_RELAY_BUNDLE_URL`、`RELAY_ID`，且**不再**以「请先放仓库」作为成功路径；包缺失时接口 503 |
| 预检 | 稀疏 PATH：缺 node / node 21 → 64 且安装根无 release；缺 tar/sha256sum → 64 |
| 校验 | 篡改 tarball 一个字节 → 66，`current` 不变，服务未启动 |
| tar 安全 | 含 `../` 或绝对路径的恶意包 → 67，未写出安装根之外的文件 |
| 幂等 | 同脚本连跑两次：只有一个 release 被激活、`RELAY_ID` 不变、平台登记一条 |
| 升级/回滚 | 注入「能解包但启动即退出」的包（伪造可执行入口）→ 70 并回滚到上一版，服务恢复 online |
| 守护分支 | 有 systemctl 写 unit 且不含 `RestartPreventExitStatus=3`；无 systemctl 写 wrapper 且不谎称开机自启 |

脚本测试复用 `install-wizard.e2e.test.ts:154` 的 `runInstallScript` 干净 shell 夹具，并把它扩展为可注入本地 bundle 与假 `systemctl`；现有 U182 relay 断言（`:615-645`）改为新语义——缺 node 仍是 64，但「缺中继代码」不再是默认路径，而是 `ORCA_RELAY_BUNDLE` 缺失时的 65。

### 6.2 干净容器验收（正向）

环境：Debian 12 amd64，**无 Orca 包、无仓库 checkout、无 `cloud-platform` 源码**，仅 bash/curl/tar/sha256sum + Node 22.18；平台可达；空 HOME。

1. 管理员生成 relay 安装命令，目标机执行 one-liner；
2. 脚本退出 0，stdout 含 relay id、版本、`host:port`、env 路径；
3. `ps` 中恰一个 `node …/current/apps/relay/src/relay.ts`；无人工启动；
4. 平台 `/v1/relays`（或内部 `/v1/internal/relays`）出现该 `RELAY_ID`，`online=true`，`lastSeenAt` 在 30s 内；
5. `relay.env` 权限 0600、目录 0700；文件不含 bundle 之外的多余内容；
6. 平台 `/connect` 能把该中继列为回落端点（在有宿主路由时）；
7. 证据：脚本 stdout/stderr、`releases/` 树、`current` 链接、env 脱敏副本、平台 relays JSON、进程树。

### 6.3 负向验收

| # | 注入 | 期望 |
| --- | --- | --- |
| N1 | 篡改 tarball（sha 不符） | 66；无 release、无服务、`current` 不变 |
| N2 | 平台不可达/健康检查 500 | 68；未下载、未写 env |
| N3 | 包端点 404（构建设置错误） | 65；脚本可复制错误码给管理员 |
| N4 | 目标机无 Node / Node 20 | 64；不写安装根 |
| N5 | 解包后入口启动即退出 | 69 或 70；若为升级则回滚并恢复 online |
| N6 | 平台可达但内部接口 401（令牌不匹配） | 70 超时，输出平台 relays JSON/日志尾部；提示检查内部令牌 |
| N7 | 并发运行两次 | 一次 0、一次 75；平台仅一条 |
| N8 | 无 systemd 容器 | 服务以 nohup 运行并 online；输出明示重启后需重跑 |

### 6.4 非目标

- 自动安装 Node 运行时（Q1 保留）；
- 自动升级/自更新（升级=重跑命令）；
- 浏览器模式证书签发（沿用既有 `RELAY_BROWSER_*`，本设计不生成证书）；
- Windows 中继机；
- 平台侧多中继调度策略。

---

## 7. 实现拆分（每令 ≤20 分钟）

> 约定：每令独立提交；R12 先于 R4–R11 与 U181 H9/H10；R1/R2/R3 可并行。时间含测试。

| 令 | 内容 | 主要文件 | 依赖 | 机检点 | 估时 |
| --- | --- | --- | --- | --- | --- |
| **R1** | 包构建脚本：固定 tar 元数据、4 文件清单、`VERSION`、输出 `<sha>.tgz` | `cloud-platform/scripts/build-relay-bundle.mjs`、测试 | 无 | 两次构建 sha 相同；清单恰好 4 项 | 20 |
| **R2** | 平台下发：`GET /install/relay-bundle/<sha>.tgz`；`relay.sh` 内嵌 sha/version/url；包缺失 503 | `server.ts`、测试 | R1 | 生成文本断言；缺失包不生成脚本 | 20 |
| **R3** | `RELAY_ID`：`relay.ts` 读 env 并传给 `startRelay`；默认 `${hostname}:${port}`；`--preflight` 模式 | `relay.ts`、测试 | 无 | id 进入 announce；preflight 不 listen、无 HTTP | 20 |
| **R12** | 抽取共享片段：preamble/health/systemd/env/unit/wrapper/poll | 新 `install-script-snippets.ts`、`server.ts`、测试 | 无 | host/relay 生成文本均含共享片段；现有测试不变 | 20 |
| **R4** | relay 预检：工具、Node 版本、安装根可写、失败码 64/78 | `server.ts`（`relayInstallScript`）、测试 | R12 | 稀疏 PATH 矩阵 | 20 |
| **R5** | 下载与校验：内容寻址 URL、缓存、`ORCA_RELAY_BUNDLE`、sha256、失败码 65/66 | `server.ts`、测试 | R2,R4 | 篡改/404/离线断言 | 20 |
| **R6** | 安全解包与激活：条目检查、必需文件、`releases/<sha>`、`current`/`previous` 原子切换 | `server.ts`、测试 | R5 | 恶意 tar 被拒；激活幂等 | 20 |
| **R7** | env 写入：原子写、0600、`RELAY_ID`/`PORT`/`RELAY_PUBLIC_HOST`/`INTERNAL_TLS_*` | `server.ts`、测试 | R6 | 权限/内容/重跑不丢键 | 15 |
| **R8** | systemd 安装：unit 绝对路径、`enable --now`、linger 告警 | `server.ts`、测试 | R7,R12 | unit 文本断言；无 systemd 不进入 | 20 |
| **R9** | 无 systemd：wrapper + nohup/setsid + pid + 停止/重启 | `server.ts`、测试 | R7,R12 | wrapper source env；重启不并发 | 15 |
| **R10** | 自证：轮询 `/v1/internal/relays`、`RELAY_ID` 匹配、60s 超时、证据输出 | `server.ts`、测试 | R8,R9 | online/超时夹具；401 可区分 | 20 |
| **R11** | 幂等/升级/回滚：安装锁、同 sha 复用、新 sha 切换、失败自动回滚 | `server.ts`、测试 | R10 | 连跑/升级/坏包回滚断言 | 20 |
| **R13** | 容器 e2e 正向：干净 Debian + Node、无 Orca/仓库，one-liner → online + 证据 | `cloud-platform/test/e2e/` | R11 | §6.2 全断言 | 20 |
| **R14** | 容器 e2e 负向：N1/N2/N4/N5/N7/N8 | e2e 测试 | R13 | 各失败码与无副作用 | 20 |

共 **14 令**。关键路径：`R1→R2→R5→R6→R7→{R8,R9}→R10→R11→R13→R14`；`R3`、`R12` 与 R4 可并行先行。

---

## 8. 开放问题（Q1–Q5）

| # | 问题 | 建议默认 | 影响 |
| --- | --- | --- | --- |
| Q1 | 是否在包内附带 Node 运行时？ | **不带**：要求系统 Node ≥22.18，预检失败给 64 与安装指引 | 带 Node 会让包变成按架构分发（x64/arm64），且体积翻倍；目标 fleet 若普遍无 Node 再单独立项 |
| Q2 | bundle 端点是否需要鉴权？ | **公开但内容寻址**：包内无密钥，sha 由管理员脚本钉死；管理员脚本本身仍受门禁 | 若安全评审要求隐藏源码，改为沿用 install download token 的短期签名 URL，需二次下载凭据 |
| Q3 | 默认安装根？ | **`$HOME/.orca-cloud/relay`**（无需 sudo）；`ORCA_RELAY_ROOT=/opt/orca-cloud/relay` 时要求可写（root） | 修正现状「默认 `/opt` + user unit」的隐性 sudo 前提 |
| Q4 | 中继身份？ | **新增 `RELAY_ID`**，默认 `${hostname}:${port}`，首次写入 env 后保持不变 | 不新增则继续用 `relay:<port>`，同端口多中继会互相覆盖，自证也不可靠 |
| Q5 | 升级/回滚策略？ | **不自动升级**；重跑即升级；保留 N-1，失败自动回滚并退出 70 | 自动更新会把「平台发版」变成「所有中继被动变更」，与 host 的显式重跑语义不一致 |

---

## 9. 待审表

| # | 审阅意见 | 结论（采纳/修改/否决） | 审阅人 | 日期 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |
|  |  |  |  |  |
