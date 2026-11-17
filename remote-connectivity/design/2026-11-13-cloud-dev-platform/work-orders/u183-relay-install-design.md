# U183 设计令 v3 · 中继安装向导必须真正安装并上线中继

- 日期：2026-11-17
- 版本：v3（`cloud-platform/test-reports/u183-v2-review.md` 的 CHANGES-REQUIRED 修订；v2 全文见附录 B）
- 性质：设计（只设计，未改产品代码）
- v1 基线：`f34e2c437a8`（原文保留在附录 A）
- v2 基线：`34b8b7991f0`（原文保留在附录 B）
- 输入：`defect-ledger.md` U183、`deployment-real-link.md` §0/§2/§3、`u181-host-mode-design.md` v3、`u183-v2-review.md`、`cloud-platform/apps/api/src/server.ts` 的 `relayInstallScript`、`cloud-platform/apps/relay/src/relay.ts`、`cloud-platform/test/e2e/install-wizard.e2e.test.ts`
- 结论：**方案 A——平台下发内容寻址的 relay 源码包（tarball + 包外清单）**；安装脚本完成下载、校验、安全解包、激活、装服务，并以不可冒名的进程身份 + 平台登记自证 `online`。仓库 clone（C）只保留为显式离线/开发逃生口；随 Orca 包分发（B）与容器化（D）本次不采用。
- 复核基线：当前工作树（含未提交的 U182 批 2）。行号会漂移，引用以「文件:符号」为准。

---

## 0. 结论摘要（v3）

| 项 | v3 结论 |
| --- | --- |
| 分发形态 | 平台构建时生成确定性源码 tarball，按 sha256 内容寻址：`/install/relay-bundle/<sha256>.tgz` |
| 版本元数据 | 包内 `VERSION` 只含 `schemaVersion` + `relayCodeVersion`（源码常量）；`bundleSha256` 由发布脚本写入**包外**清单 `relay-bundle-<sha>.manifest.json`；`builtAt` 可选、不参与 sha |
| 入口守卫 | `relay.ts` 主块改为双侧 `realpathSync` 比较（带 try/catch 回退）；`current` 符号链接安装后可正常执行（P0-1） |
| 校验 | sha256 在管理员生成的 `relay.sh` 中内嵌并钉死；下载后再比对；包外清单只用于生成命令，不参与目标机信任链 |
| 下载 TLS | 按平台 URL scheme 生成：https → `--proto '=https' --tlsv1.2`；http（仅本地测试）→ 不加 proto 限制，但**仍以脚本内嵌 sha256 钉死**。**生产强制 https**（B2） |
| 安装位置 | 默认 `$HOME/.orca-cloud/relay`（无 sudo）；`ORCA_RELAY_ROOT` 可指向 `/opt/orca-cloud/relay`；env 固定为 `<ROOT>/relay.env` |
| 运行时 | 目标机需 Node ≥22.18（`cloud-platform/package.json:14`）；包内无需 `node_modules` |
| 激活 | 解包到 `releases/<sha>/`，原子切换 `current` 符号链接；按 sha 变化保留 N-1 供回滚 |
| 守护 | 有 user systemd 则装 unit 并 `enable --now`；否则 wrapper + nohup + pid 文件 |
| unit 契约 | 必含 `EnvironmentFile=<ROOT>/relay.env`；`ExecStart=<NODE> <ROOT>/current/apps/relay/src/relay.ts`；不含 `RestartPreventExitStatus=78`（该键属 host unit，由 H10a 加） |
| 自证 | systemd 用 `MainPID` + 进程 cmdline/启动单调时间；nohup 用 pid 文件 + cmdline；另加可选 `installNonce` 回显。`lastSeenAt` 是平台毫秒 epoch，只用于平台侧 `online`，不与目标机墙钟直接比较 |
| 幂等 | 同 sha 复用 release 与下载缓存；只有 sha 变化才更新 `previous`；失败自动回滚 |
| 归属 | **命令预检/systemd 探测 helper 由 U183 R12 从现有内联片段抽取并拥有**（新 `install-script-command.ts`）；U181 H9a/H10a 消费同一 helper；unit 模板、linger、无 systemd wrapper 归 H10a/H10b；U182 批 2 只内联过 `command -v`，没有可复用 helper（B1） |
| 拆分 | 22 令，全部 ≤20 分钟；容器基建与负向场景已拆开（见 §7） |

### 0.1 两个必须先说清的命名陷阱

1. Orca 安装包里的 `out/relay/`（`config/electron-builder.config.cjs:102-127`）是**桌面 SSH 中继资产**（`relay.js`、`relay-watcher.js`、WSL relay 等），与云平台的 `cloud-platform/apps/relay` **不是同一个东西**。U183 不得复用 `out/relay`。
2. 当前 `relay.ts:688` 的入口守卫是 `if (import.meta.url === \`file://${process.argv[1]}\`)`。Node 默认对主模块取 realpath，而 `process.argv[1]` 保留符号链接路径，因此任何路径段是符号链接都会让主块不执行、进程 exit 0。v3 把修复钉死在 R3，见 §3.1。

---

## 1. 现状与缺口（修正措辞）

### 1.1 脚本实际做了什么

`server.ts:451` `relayInstallScript()` 生成的脚本只有四段：

| 位置 | 动作 | 事实 |
| --- | --- | --- |
| `server.ts:460-466` | 检查 `node` | 仅内联 `command -v node`，不校验版本；注释写明「本脚本不安装中继运行时」 |
| `server.ts:467-472` | 检查中继入口 | 要求 `$ORCA_RELAY_ROOT/cloud-platform/apps/relay/src/relay.ts` 已存在；不存在即 exit 1 |
| `server.ts:474-484` | 写 `relay.env` | `ORCA_CLOUD_API_URL`、`ORCA_CLOUD_INTERNAL_TOKEN`、`PORT`、`RELAY_PUBLIC_HOST` |
| `server.ts:486-496` | 平台健康检查 | 有界、不跟重定向、只认 2xx（U182） |
| `server.ts:498-536` | **只打印** | 打印 `node relay.ts`、systemd unit 文本或 nohup 命令，**不执行** |

全脚本没有 `curl` 下载（`curl` 只用于 `/health`）、没有 `tar`、没有 `sha256`、没有 `cp/install`、没有 `systemctl enable`。缺陷台账 U183 的「无下载、无安装、无服务创建」与代码一致。

### 1.2 目标机前提与代码事实

1. **入口是 TypeScript，且跨目录相对导入**：`relay.ts:10` `import { mtlsFetch } from '../../../packages/contract/src/internal-fetch.ts'`，`relay.ts:11` `./sni.ts`。释放目录必须保留 `apps/relay/src` 与 `packages/contract/src` 的相对层级。
2. **没有 npm 依赖**：`cloud-platform/package.json` 没有 `dependencies`，`internal-fetch.ts` 只 import `node:fs`/`node:https`。包不需要 `pnpm install`。
3. **Node 版本是硬前提**：`cloud-platform/package.json:14` `"node": ">=22.18"`，即默认启用 type stripping 的版本。
4. **注册即自证**：中继 listen 后先 `refresh()`（`relay.ts:660-668`），成功后 `announce()`（`relay.ts:340-344,348-377`）向 `POST /v1/internal/relay-endpoint` 报到；平台按 30s 窗口判 `online`（`relay-nodes.ts:7`、`server.ts:4581-4592`）。
5. **默认 id 会撞车**：未显式给 `id` 时平台用 `relay:${port}`（`relay-nodes.ts:58`），同端口的多台中继会互相覆盖。自证必须能唯一识别本机中继。
6. **当前默认安装根不可写风险（修正）**：脚本默认 `/opt/orca-cloud`，却**打印** user systemd unit（`server.ts:507-518`），并不安装；真实矛盾是「要求代码在 `/opt`」+「给出 user unit 文本」+「env 写到 `$HOME`」三者不一致。v1 §1.2.6 的「却安装 user unit」措辞已删除，当前代码不安装任何 unit。
7. **U182 批 2 没有交付可复用 helper（v3 修正）**：提交 `22424e91280` 只在 host/relay 两个生成脚本模板里内联了 `command -v node` / `command -v systemctl`。当前工作树 `grep -rn require_command cloud-platform/apps cloud-platform/test` 为空（仅命中评审文档）；user bus / systemd 版本 / 键支持的**能力探测 helper 全仓不存在**。因此 v2 「复用 U182 批 2 helper」不成立，v3 改由 R12 抽取，见 §5。

### 1.3 验收缺口

`deployment-real-link.md:61` 把「Node ≥22.18 + 仓库代码（或镜像）」列为中继机前置，`:72` 却承诺管理台一键命令。现状等于把「把仓库放到 `/opt/orca-cloud`」这件未写入任何步骤的事留给操作者。U182 容器回归（`evidence/u182-b2-regress-20261117T170856/`）在预检阶段即退出，没有创建任何中继服务。

---

## 2. 方案与包契约

### 2.1 候选与取舍（结论不变）

| 案 | 形态 | 结论 |
| --- | --- | --- |
| **A** | **平台下发源码 tarball**：脚本从平台下载 `.tgz`，校验 sha256，解包到安装根，装服务 | **推荐** |
| B | 随 Orca 安装包分发云中继 | 否：与客户端发版耦合，中继机通常不装桌面 Orca |
| C | 仓库 clone/依赖已装 | 仅显式逃生口，脚本不执行 `git clone`/`pnpm install` |
| D | 容器化 | 否：中继机前提里没有容器运行时，多一个高权限守护进程 |

保留的逃生口：`ORCA_RELAY_BUNDLE=/path/to/relay-bundle-<sha>.tgz`（离线/气隙，仍校验内嵌 sha）与 `ORCA_RELAY_ROOT` 指向既有解包目录（仅开发，见 §2.5）。

### 2.2 信任模型（v3 写成结论）

根信任 = **HTTPS + 管理员/一次性下载令牌 + `relay.sh` 内嵌 sha256**。

- 内容寻址 + 内嵌 sha 能防传输篡改与 MITM（TLS 前提下）。
- **不能**防平台被攻陷：脚本与包同源，攻陷平台者可同时替换二者。
- **不能**防 `relay.sh` 本身被篡改：一次性令牌的 one-liner 仍是 `curl -fsSL`（`install-wizard.e2e.test.ts:78`），其加固不属于本设计；本设计把 bundle 下载参数按平台 scheme 生成（R2）：
  - 平台 URL 为 `https` → `curl -fsS --proto '=https' --tlsv1.2`；
  - 平台 URL 为 `http` → 不加 `--proto`，仅用于 `install-wizard.e2e.test.ts` 这类**本地测试/开发**平台；下载后仍与脚本内嵌 sha256 逐字节比对，完整性不降级。
- **生产强制 https**：非 loopback 的 http 平台在 `relay.sh` 生成阶段即拒绝（500/配置错误），或由部署门禁拒绝启动；http 仅允许 loopback/本地测试。
- 包内无任何密钥，因此 bundle 端点**公开**是默认结论，不再作为开放问题（Q2 收敛，见 §8）。

### 2.3 构建产物与目录

新增 `cloud-platform/scripts/build-relay-bundle.mjs`：

```
$OUT/relay-bundle-<bundleSha256>.tgz
$OUT/relay-bundle-<bundleSha256>.manifest.json
```

- `$OUT` 默认 `cloud-platform/var/relay-bundles`（gitignore），可用 `ORCA_RELAY_BUNDLE_OUT` 覆盖。
- tarball 根（必需集 = `VERSION` + `relay.ts` 的 import 闭包）：

```
VERSION
apps/relay/src/relay.ts
apps/relay/src/sni.ts
apps/relay/src/relay-version.ts
packages/contract/src/internal-fetch.ts
```

- 不含 `node_modules`、`.git`、证书、env、测试、文档。包内**无任何密钥**。
- 确定性构建（R1 固定参数）：`tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - <文件清单>` 管道 `gzip -n`。**只传文件清单，不传目录参数**；`tar` 会为路径自动补目录条目（`d`），这是允许的，但不得由目录参数递归引入额外文件。
- **禁止 pax 扩展头**（`x`/`g`）：固定 `--format=ustar`；路径超 ustar 上限时构建失败，不回退 pax。
- 同一输入两次构建的 tgz 字节与 sha 相同。文件清单按 import 闭包断言「必需集齐全 + 无多余项」，不再写死「恰好 4 项」。

### 2.4 版本与 sha 契约（P0-2）

**包内 `VERSION`**（由源码常量生成，不含包自身 sha）：

```json
{"schemaVersion":1,"relayCodeVersion":"0.1.0"}
```

- `schemaVersion`：bundle 布局/安装脚本契约版本，布局不兼容时递增。
- `relayCodeVersion`：中继源码版本，来自新文件 `cloud-platform/apps/relay/src/relay-version.ts` 的导出常量；`relay.ts` 在启动日志打印它。
- **不放 `bundleSha256`**：包内文件不能包含包含它自身的 tarball 的 sha（不动点不存在）。
- **不放 `builtAt`**：构建时刻会破坏二次构建同 sha；若发布流程需要审计时间，只写包外清单。

**包外清单** `relay-bundle-<bundleSha256>.manifest.json`（发布脚本在 tgz 定稿后写入，不在 tarball 内）：

```json
{
  "bundleSha256": "<64 位小写 hex，等于文件名中的 sha>",
  "schemaVersion": 1,
  "relayCodeVersion": "0.1.0",
  "files": ["VERSION", "apps/relay/src/relay.ts", "..."],
  "builtAt": "2026-11-17T09:30:00Z"
}
```

- `bundleSha256` 对 tarball 原始字节计算，与文件名、URL、`relay.sh` 内嵌值三方一致。
- `builtAt` **可选**，不参与 sha、不参与清单相等性判断；测试只比较 `bundleSha256`/`schemaVersion`/`relayCodeVersion`/`files`。
- 清单中的 `schemaVersion`/`relayCodeVersion` 必须与包内 `VERSION` 相等（R1 交叉断言）。
- 清单**不**对外提供下载；只在平台生成 `relay.sh` 时从磁盘读取。

### 2.5 平台存放与路由契约（P1-4）

**存放**：

| 项 | 契约 |
| --- | --- |
| 目录 | `ORCA_RELAY_BUNDLE_DIR`，默认 `<repo>/cloud-platform/var/relay-bundles` |
| 包文件 | `<DIR>/relay-bundle-<sha>.tgz` |
| 清单文件 | `<DIR>/relay-bundle-<sha>.manifest.json` |
| sha 校验 | 请求路径只接受 `^[0-9a-f]{64}$`；不接受 basename 以外的任何路径段 |
| sha→文件 | 直接拼 `<DIR>/relay-bundle-<sha>.tgz`；不做目录扫描、不做「最新版本」猜测 |
| 当前版本 | 不定义「当前」；管理员生成命令时显式选择构建产物，sha 即版本 |

**生成 `relay.sh` 的判定**（`server.ts` 的管理员/下载令牌分支）：

1. 目标 sha 的 `.tgz` 不存在 → `503 RELAY_BUNDLE_UNAVAILABLE`，**不生成注定失败的脚本**；
2. `.tgz` 存在但 `.manifest.json` 缺失 → `500 RELAY_BUNDLE_MANIFEST_MISSING`（部署错误）；
3. 清单中的 `bundleSha256` 与请求 sha 不符 → `500 RELAY_BUNDLE_MANIFEST_INVALID`；
4. 平台对外 URL 为 http 且 host 非 loopback → 拒绝生成（生产强制 https，B2）；
5. 通过后把 sha、`schemaVersion`、`relayCodeVersion`、URL、scheme 决定的下载参数写入脚本 env。

**路由与鉴权**：

| 路由 | 鉴权 | 缓存 | 说明 |
| --- | --- | --- | --- |
| `GET /install/relay.sh`（及一次性 token 变体） | 管理员或一次性 download token（`server.ts:2384-2427`），用后即焚 | `cache-control: no-store`（`server.ts:2441-2444`） | 含内部令牌，绝不缓存 |
| `GET /install/relay-bundle/<sha>.tgz` | **公开**（包内无密钥；sha 由脚本钉死） | `cache-control: public, max-age=31536000, immutable`；`ETag: "<sha>"` | 必须注册在 `/install/*` 通用鉴权分支**之前**，避免被 admin 门禁误伤 |
| 清单 | 不对外 | — | 仅服务端读盘 |

安全评审若要求隐藏源码，改为短期签名 URL + `no-store`，属于 Q2 的另一分支；默认不采用。

**离线逃生口**：

- `ORCA_RELAY_BUNDLE=/abs/path/relay-bundle-<sha>.tgz`：跳过下载，仍与脚本内嵌 sha 比对；不要求同目录有清单（版本号来自脚本内嵌值）；若同目录存在清单且 `bundleSha256` 不符 → 66。
- `ORCA_RELAY_ROOT` 指向已解包的开发目录：仅开发用，必须同时给 `ORCA_RELAY_ALLOW_UNVERIFIED=1`，脚本打印显著警告；生产预检拒绝该组合（78）。

### 2.6 脚本内嵌值

```sh
ORCA_RELAY_BUNDLE_SHA256=<64 hex>
ORCA_RELAY_BUNDLE_URL=<platform>/install/relay-bundle/<sha>.tgz
ORCA_RELAY_SCHEMA_VERSION=1
ORCA_RELAY_CODE_VERSION=0.1.0
ORCA_RELAY_DOWNLOAD_TLS=1        # 由平台 URL scheme 决定：https=1，http=0
```

运行时契约不变：`node <root>/current/apps/relay/src/relay.ts`，env 仍读 `ORCA_CLOUD_API_URL` / `ORCA_CLOUD_INTERNAL_TOKEN` / `PORT` / `RELAY_PUBLIC_HOST`（`relay.ts:195`、`:693-709`），新增 `RELAY_ID` 与安装 nonce（见 §3、§7 R3/R10a）。

---

## 3. 安装时序（v3）

脚本按以下顺序执行；**任何一步失败都不启动服务**，并在 stderr 给出稳定码。

| # | 步骤 | 细节 | 失败码 |
| --- | --- | --- | --- |
| 1 | 预检工具 | `bash`、`curl`、`tar`、`sha256sum`（macOS 回退 `shasum -a 256`）、`node` 版本 ≥22.18；安装根可写（默认 `$HOME/.orca-cloud/relay`）；调用 **R12 的 `install-script-command.ts`**（`require_command`、Node 版本比较、systemd 能力探测） | 64 / 78 |
| 2 | 平台健康 | `GET <platform>/health`，5s 连接 / 10s 总超时，不跟重定向，只认 2xx；记录响应 `Date` 头供时钟容差 | 68 |
| 3 | 取得包 | 按脚本内嵌 `ORCA_RELAY_DOWNLOAD_TLS` 选参数：`1` → `curl -fsS --proto '=https' --tlsv1.2`；`0` → `curl -fsS`（仅本地测试，脚本启动时打印非 TLS 警告）。下载到 `<ROOT>/downloads/<sha>.tgz.part`；已存在且校验通过则跳过；`ORCA_RELAY_BUNDLE` 时直接使用本地文件 | 65 |
| 4 | 校验 | 对 tarball 算 sha256，与脚本内嵌值逐字节比对；不匹配删除临时文件 | 66 |
| 5 | 安全检查 | `tar -tvzf` 逐条解析类型标记与链接目标：**允许普通文件 `-` 与目录 `d`**；拒绝 symlink `l`、hardlink `h`、block/char device `b`/`c`、FIFO `p`、socket `s`，以及 pax 扩展头 `x`/`g`；拒绝绝对路径、`..`、以及白名单外的顶层项；白名单 `VERSION`、`apps/`、`packages/` | 67 |
| 6 | 解包 | 新建空目录 `<ROOT>/releases/<sha>.tmp-$$`；`tar -xzf --no-same-owner --no-same-permissions --no-overwrite-dir`；解包后 `find` 真实树复查，**拒绝既非普通文件也非目录的条目**（`! -type f ! -type d`）与逃逸路径；校验必需文件存在且为普通文件；原子 `mv` 为 `<ROOT>/releases/<sha>` | 67 |
| 7 | 运行时预检 | 通过**真实 release 路径**执行 `node <release>/apps/relay/src/relay.ts --preflight`（R3 新增）：只解析 env、校验 Node/模块图，不 listen、不发 HTTP、不注册；同时回归符号链接路径（P0-1） | 64 / 78 |
| 8 | 激活 | `ln -sfn` 到临时链接后 `rename` 为 `<ROOT>/current`；**仅当新 sha 与当前 `current` 不同**时把旧目标写入 `<ROOT>/previous`；同 sha 重跑不覆盖 `previous` | 67 |
| 9 | 写 env | 临时文件 + `fsync` + `rename`，`0600`；写入 API URL、内部令牌、`PORT`、`RELAY_PUBLIC_HOST`、`RELAY_ID`、可选 `INTERNAL_TLS_*`、本次安装 nonce；文件为 systemd `EnvironmentFile` 兼容语法（`KEY=VALUE`，无 `export`） | 78 |
| 10a | systemd | 用 R12 的探测结果判断 user systemd 可用性；用 H10a 的参数化模板写 `~/.config/systemd/user/orca-relay.service`；`daemon-reload` + `enable --now`；`loginctl enable-linger` 失败只告警；unit 全文见 §3.2 | 69 |
| 10b | 无 systemd | 用 H10b 的 wrapper 模板写 `<ROOT>/run-relay.sh`（显式 `set -a; . <ROOT>/relay.env; set +a; exec node <ROOT>/current/apps/relay/src/relay.ts`），`nohup setsid` 启动，把**子进程实际 pid** 写入 `<ROOT>/relay.pid`；明示不随开机自启 | 69 |
| 11 | 自证 | 记录本次安装单调起点；按 §3.3 校验进程身份与平台登记；默认 60s 超时 | 70 |
| 12 | 成功输出 | 打印 relay id、`host:port`、`relayCodeVersion`、配置文件路径、停止/回滚命令 | 0 |

补充：先 listen 后同步是 relay 既有语义（`relay.ts:658-668`），平台不可达时进程仍会在 listen 后每 2s 重试（`relay.ts:379-385`）。因此「进程起来了」不等于「上线」，第 11 步必须查平台登记，不能只看 `kill -0`。

### 3.1 P0-1 入口守卫修复（钉死，含 try/catch）

`relay.ts:688` 改为：

```ts
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

const invokedPath = process.argv[1] ? safeRealpath(process.argv[1]) : null
const modulePath = safeRealpath(fileURLToPath(import.meta.url))
if (invokedPath && invokedPath === modulePath) {
  // ... 现有启动主块 ...
}
```

- 两侧都取 realpath，覆盖「路径前缀是符号链接」（如 macOS `/tmp -> /private/tmp`）与「叶子是符号链接」（`current`）两种情形。
- `try/catch`：被 `import` 时 `argv[1]` 可能指向已删除文件；解析失败回退 `null`，保持「不启动」语义且不抛错（v2 评审 P2）。
- 安装形态选择：`ExecStart`/wrapper **继续指向 `<ROOT>/current/...`**，回滚只切符号链接并重启，不重写 unit。备选的「ExecStart 指向 `releases/<sha>`」需要回滚时重写 unit，v3 不采用；install 时生成 wrapper 的备选也不需要。
- 测试（R3，机检）：
  1. 在 `$TMPDIR` 建 `releases/<sha>/apps/relay/...` 与 `current` 符号链接；`node current/apps/relay/src/relay.ts --preflight` 必须 exit 0 且输出预检标记（证明主块执行，不是静默 exit 0）。
  2. 真实路径 `node releases/<sha>/... --preflight` 同样 exit 0。
  3. 在 `/tmp`（macOS 上本身是符号链接）下重复 1，覆盖路径前缀符号链接。
  4. 负例：`process.argv[1]` 指向不同文件时不执行主块（保持原有「被 import 时不启动」语义）。
  5. 负例：`process.argv[1]` 指向已删除文件时不抛错、不执行主块。

### 3.2 unit 模板（P0-3，完整）

`ORCA_ENV_FILE=<ROOT>/relay.env`；`<ROOT>`、`<NODE_BIN>` 在生成时写成绝对路径（不能依赖 `%h`，因为 `ORCA_RELAY_ROOT` 可自定义）：

```ini
[Unit]
Description=Orca Cloud Relay
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
EnvironmentFile=<ROOT>/relay.env
ExecStart=<NODE_BIN> <ROOT>/current/apps/relay/src/relay.ts
WorkingDirectory=<ROOT>/current
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

- **必须**有 `EnvironmentFile=<ROOT>/relay.env`：中继所有配置来自 env（`relay.ts:693-709`），缺它会让 `announce()` 无令牌/无 URL，第 11 步必然 70。
- **不写** `RestartPreventExitStatus=78`：relay 的 `ExecStart` 直接跑 `relay.ts`，正常运行时不会以 78 退出；78 是安装脚本的退出码。该键属于 host unit，由 H10a 生成时加入。
- `StartLimit*` 放 `[Unit]`（systemd ≥229）；老 systemd 由 R12 探测结果降级为 `Restart=no` 并在输出中告警。
- R8 的文本断言必须覆盖：含绝对 `EnvironmentFile`、`ExecStart` 指向 `current`、不含 `RestartPreventExitStatus=78`、`StartLimitBurst` 存在（systemd 支持时）。

### 3.3 自证判据（P1-2）

**进程身份（不可冒名）**：

| 分支 | 判据 |
| --- | --- |
| systemd | `systemctl --user show -p MainPID --value orca-relay.service` 得到 pid > 0；`/proc/<pid>/cmdline` 的入口 realpath 必须等于 `<ROOT>/releases/<sha>/apps/relay/src/relay.ts`；`systemctl show -p ActiveEnterTimestampMonotonic` 必须 >= 本次安装开始时的单调时间（读 `/proc/uptime`），不受墙钟影响 |
| nohup | `<ROOT>/relay.pid` 中的 pid 必须存活（`kill -0`）；`/proc/<pid>/cmdline` 的入口 realpath 必须指向本次 release；`/proc/<pid>/stat` 的 starttime 换算后必须 >= 本次安装单调起点 |

**nonce（第二证据，跨版本安全）**：

- 第 9 步生成本次安装 nonce，写入 `relay.env` 的 `ORCA_RELAY_INSTALL_NONCE`。
- relay 的 announce 请求体新增**可选** `installNonce` 字段；平台 `/v1/internal/relays` 回显（可选字段，旧服务端忽略、旧中继不发送）。
- 新中继 + 旧平台：平台不回显，脚本回退到进程身份 + `online`，打印一条降级警告。
- 旧中继 + 新平台：无 nonce，脚本同样回退。
- 只有 nonce 匹配（或明确降级）且进程身份匹配，才判定本次安装成功；旧 release 进程以同一 `RELAY_ID` 刷新无法冒名。

**`lastSeenAt` 单位与时钟容差**：

- `lastSeenAt` 是**平台侧毫秒 epoch**（`relay-nodes.ts` 的 `nowMs`），不是秒、不是 ISO 字符串。
- 平台 `online` 判据是 `now - lastSeenAt <= 30_000`（`server.ts:4581-4592`）；脚本只看该布尔值。
- 脚本**不**用目标机墙钟与 `lastSeenAt` 直接比较。若旧平台缺少 nonce 且必须比较，用第 2 步响应的 `Date` 头估算偏移，容差取 `max(5s, |skew| + 2s)`，并在输出中打印 skew。
- 401/403 与超时分开报告：401 输出「内部令牌不匹配」提示；超时输出平台 relays JSON 与日志尾部。

---

## 4. 失败码、幂等与升级/回滚

### 4.1 稳定失败码

| 码 | 名称 | 触发 | 可重试 | 副作用 |
| --- | --- | --- | --- | --- |
| 0 | — | 安装并上线 | — | 服务运行 |
| 64 | `relay_runtime_missing` | 缺 curl/tar/sha256sum，`node` 缺失或 <22.18 | 是（补依赖） | 未写安装根（除 downloads 目录） |
| 65 | `relay_bundle_unavailable` | 下载失败/404/平台 5xx/`ORCA_RELAY_BUNDLE` 不存在 | 是 | 无 |
| 66 | `relay_bundle_checksum_mismatch` | sha256 与内嵌值不符 | 是（重新下载） | 删除坏包 |
| 67 | `relay_bundle_unpack_failed` | tar 非法条目/类型、缺文件、激活失败 | 否（换包） | 保留旧 `current` |
| 68 | `relay_platform_unreachable` | `/health` 非 2xx 或超时 | 是 | 无 |
| 69 | `relay_service_install_failed` | unit 写入/启动、wrapper/nohup 失败 | 视原因 | env 已写，服务未就绪 |
| 70 | `relay_not_online_timeout` | 60s 内未通过自证 | 是（看日志/平台） | 自动回滚（若存在 previous） |
| 75 | `relay_install_busy` | 另一安装进程持锁 | 是 | 无 |
| 78 | `relay_config_invalid` | 安装根不可写、参数/环境冲突、`--preflight` 不过、生产使用未校验目录 | 否 | 无 |
| 1 | 未分类 | 兜底 | 视原因 | — |

注：64–78 是**安装脚本**退出码，不承诺覆盖 sysexits 全部语义；70 取「脚本级超时」含义，不映射 `EX_SOFTWARE`。

### 4.2 幂等

| 场景 | 行为 |
| --- | --- |
| 重跑，同 sha | 命中 `downloads/<sha>.tgz` 与 `releases/<sha>`，跳过下载/解包；原子重写 env（nonce 换新）；`restart` 服务；`RELAY_ID` 不变；**`previous` 不更新** |
| 重跑，新 sha | 新 release 解包 → `previous=current`（仅此处更新）→ `current=新` → 重启；旧 release 保留 |
| 并发执行 | `flock`（无则 `mkdir` 锁）在 `<ROOT>/.install.lock`；拿不到退出 75 |
| env 已存在 | 不删除、不重置；只覆盖本次受管键；`RELAY_ID` 一旦生成则保持稳定 |
| 服务已运行 | 先 `stop`/`TERM` 旧进程，等端口释放再启动；不并存两个中继进程 |
| 平台已有同名 `RELAY_ID` | 注册是 upsert（`relay-nodes.ts:56-67`），覆盖 host/port/lastSeenAt |
| 下载缓存 | 成功后只保留 `current`/`previous` 对应 sha 的 tgz，其余删除；失败时保留临时文件供诊断，超过 7 天清理（R15） |
| 同机多实例 | 每个实例必须使用不同 `ORCA_RELAY_ROOT` 与不同 `PORT`；env 固定 `<ROOT>/relay.env`，不同 root 天然隔离；同 root 多实例不支持 |

### 4.3 升级与回滚

- **升级**由管理员重新生成安装命令并重跑；脚本**不自更新**，中继进程也不轮询新版本。
- 只在 `current` 目标 sha 变化时把旧目标写入 `<ROOT>/previous`；同 sha 重跑保持 previous 不变，避免「回滚到同一版本」的空操作。
- 第 11 步超时（70）且 `previous` 存在：写回 previous 链接，换新 nonce 重启，再等 30s；恢复成功则退出 70 并打印「已回滚到 `<old sha>`，新版本未上线」。
- 回滚后 env 保持；回滚版本忽略未知键（如新 nonce）。
- 成功输出打印一键回滚命令（切回 `previous` 并重启）。
- 保留最近 2 个 release；更旧的由重跑时清理（只删除非 `current`/`previous` 的 `releases/*`）。

---

## 5. 归属裁定：U183 R12 / U181 H9-H10（v3 修正 B1）

### 5.1 结论

| 能力 | 归属 | U183 的动作 |
| --- | --- | --- |
| `require_command`、命令预检、命令解析、Node 版本比较 | **U183 R12（从现有内联片段抽取；U182 批 2 没有交付 helper）** | 新建 `cloud-platform/apps/api/src/install-script-command.ts`，host/relay 两端接入 |
| systemd 能力探测（user bus、版本、键支持） | **U183 R12（当前全仓无实现）** | 同一 helper 模块；探测结果供 R8/R9 与 H10a/H10b 消费 |
| user unit 模板、`StartLimit`、linger、无 systemd wrapper | **U181 H10a/H10b** | R8/R9 消费参数化模板；不复制模板实现 |
| host unit 的 `RestartPreventExitStatus=78` | **U181 H10a** | 与 relay 无关；U183 不写该键 |
| relay 安装编排、bundle、校验、激活、自证 | **U183 R1–R11** | 本设计主体 |

### 5.2 三条裁定

1. **R12 改为抽取 helper，并归 U183 自身**：v2 说「只接线 U182 批 2 的 helper、不新建模块」，但该 helper 不存在（§1.2.7）。v3 取消该错误前提：R12 新建 `cloud-platform/apps/api/src/install-script-command.ts`，从 `hostInstallScript`/`relayInstallScript` 现有内联片段抽取 `require_command`、命令解析、Node 版本比较，并补齐当前缺失的 systemd 能力探测（user bus、版本、键支持）。host 与 relay 共用；不再有第二份内联实现。R12 无前置依赖，估时 20 分钟。
2. **unit 生成归 H10a/H10b**：R8/R9 依赖 H10a/H10b 提供的参数化模板/wrapper 模板；U183 只传 `ExecStart`、`EnvironmentFile`、`WorkingDirectory`、重启策略。排期上 H10a/H10b 先落模板（各 ≤20 分钟），R8/R9 后接。若 H10a/H10b 尚未派工，R8/R9 不得自行写第二份 unit 文本。
3. **`RestartPreventExitStatus` 缺口**：当前 `server.ts` 的 host/relay unit 文本都没有该键（grep 为空）。H10a 生成 host unit 时加入 `RestartPreventExitStatus=78`；**relay unit 不加**（`ExecStart` 是 `relay.ts`，78 是安装脚本的码）。U183 R8 的断言反过来固定「relay unit 不含 78」。

### 5.3 对 U181 文档的修正提示

U181 v3 的归属表（`:451-459`）与依赖图（`:580-590`）目前写「命令预检/systemd 探测归 U182 批 2」；事实是批 2 只交付了内联 `command -v`。需同步改为：**helper 由 U183 R12 提供，U181 H9a/H10a 消费**；U181 的「relay 安装/启动」范围由 U183 接管这一条保持不变。派工 H9a/H10a 时一并修正（仅文档，另令处理）。

---

## 6. 测试与验收（v3）

### 6.1 单元/集成（无容器）

| 项 | 断言 |
| --- | --- |
| 包构建（R1） | 两次构建 tgz sha 相同；`VERSION` 仅 `schemaVersion`/`relayCodeVersion`；不含 `bundleSha256`/`builtAt`；包外清单字段齐全且 sha 与文件名一致；清单 `schemaVersion`/`relayCodeVersion` == 包内 `VERSION`；import 闭包无多余项；构建只传文件清单、固定 ustar、产物无 pax 头（目录条目允许） |
| 版本回归（R1） | 修改 `relayCodeVersion` 常量 → 新 sha、清单新值；修改任一源码字节 → sha 变化；只改 `builtAt` → tgz sha 不变 |
| 生成器（R2） | https 平台：`relay.sh` 含 `ORCA_RELAY_DOWNLOAD_TLS=1` 与 bundle 下载 `--proto '=https' --tlsv1.2`；http 本地平台：含 `=0` 且**不含** `--proto`，启动时打印非 TLS 警告；两者都含内嵌 sha/url/schemaVersion/relayCodeVersion；非 loopback http 平台拒绝生成；缺包 503；缺清单/清单 sha 不符 500；bundle 路由绕过 admin 门禁、返回 immutable；`relay.sh` 仍 `no-store` |
| 入口守卫（R3） | `/tmp` 符号链接前缀 + `current` 叶子两种路径 `--preflight` 均 exit 0 且主块执行；真实路径同样通过；`argv[1]` 指向已删除文件时不抛错、不执行主块；被 import 时不启动 |
| 预检（R4） | 稀疏 PATH：缺 node / node 21 → 64 且安装根无 release；缺 tar/sha256sum → 64；helper 由 R12 提供，host/relay 行为一致 |
| 校验（R5） | 篡改 tarball 一个字节 → 66；`current` 不变，服务未启动；`ORCA_RELAY_BUNDLE` 离线路径同样校验 |
| tar 安全（R6） | 含 symlink/hardlink/FIFO/device/socket、pax 头、`../`、绝对路径的恶意包 → 67；**目录条目与普通文件放行**；安装根之外无文件；解包后真实树复查只拒绝「非普通文件且非目录」 |
| 幂等（R11a） | 同脚本连跑两次：一个 release 被激活、`RELAY_ID` 不变、`previous` 未被同 sha 覆盖、平台登记一条 |
| 升级/回滚（R11b） | 注入「sha 合法但启动即退出」的包 → 70 并回滚到上一版，服务恢复 online；同 sha 重跑不产生假回滚 |
| 守护分支（R8/R9） | unit 含绝对 `EnvironmentFile`、`ExecStart` 指向 `current`、不含 `RestartPreventExitStatus=78`；无 systemctl 写 wrapper 且不谎称开机自启；pid 文件存在且 cmdline 指向本次 release；模板来自 H10a/H10b |
| 自证（R10b） | 同 id 旧进程 + 新版本启动失败 → 不判成功；nonce 不匹配 → 不判成功；systemd `MainPID` 指向旧 release → 不判成功；时钟偏移夹具不误判 |
| 版本混用（R10a） | 新中继 + 旧平台：忽略 nonce 回退并警告；旧中继 + 新平台：无 nonce 回退；两端都不崩 |

脚本测试复用 `install-wizard.e2e.test.ts:154` 的 `runInstallScript` 干净 shell 夹具，并扩展为可注入本地 bundle 与假 `systemctl`。现有 U182 relay 断言（`:614-648`）改为新语义：缺 node 是**新增**的 64（现状只断言非零），缺中继代码不再是默认路径，而是 `ORCA_RELAY_BUNDLE` 缺失时的 65。e2e 的平台是本地 HTTP，生成器必须走 `ORCA_RELAY_DOWNLOAD_TLS=0` 分支，否则症状是 65 而非 68。

### 6.2 干净容器验收（正向）

环境：Debian 12 amd64，无 Orca 包、无仓库 checkout、无 `cloud-platform` 源码，仅 bash/curl/tar/sha256sum + Node 22.18；平台可达；空 HOME。

1. 管理员生成 relay 安装命令，目标机执行 one-liner；
2. 脚本退出 0，stdout 含 relay id、`relayCodeVersion`、`host:port`、env 路径；
3. `ps` 中恰一个 `node …/current/apps/relay/src/relay.ts`；无人工启动；
4. 平台 `/v1/relays`（或内部 `/v1/internal/relays`）出现该 `RELAY_ID`，`online=true`，且 nonce/进程身份自证通过；
5. `relay.env` 权限 0600、目录 0700；文件不含 bundle 之外的多余内容；
6. 平台 `/connect` 能把该中继列为回落端点（在有宿主路由时）；
7. 证据：脚本 stdout/stderr、`releases/` 树、`current` 链接、env 脱敏副本、平台 relays JSON、进程树、`MainPID`/pid 文件记录。

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
- 浏览器模式证书签发（沿用既有 `RELAY_BROWSER_*`）；
- Windows 中继机；
- 平台侧多中继调度策略。

---

## 7. 实现拆分（v3，每令 ≤20 分钟）

> 约定：每令独立提交；H10a/H10b 先于 R8/R9；R3、R10a、R12、R13a 无前置，可先启动。时间含测试。

| 令 | 内容 | 主要文件 | 依赖 | 机检点 | 估时 |
| --- | --- | --- | --- | --- | --- |
| **R1** | bundle 构建：确定性 tar（固定 ustar/排序/mtime/uid/gid、只传文件清单）、import 闭包、包内 `VERSION`、包外清单（sha/versions 交叉校验） | `cloud-platform/scripts/build-relay-bundle.mjs`、`relay-version.ts`、测试 | 无 | 两次 sha 相同；VERSION 无自引用 sha/builtAt；清单版本 == 包内 VERSION；产物无 pax 头 | 20 |
| **R2** | 平台下发：bundle 目录契约、公开内容寻址路由绕过鉴权、`relay.sh` 内嵌 sha/versions、按 scheme 生成 `--proto`/TLS 参数、生产拒绝非 loopback http、503/500 判定 | `server.ts`、测试 | R1 | 缺包不生成脚本；https/http 两种参数文本断言；路由/缓存/鉴权断言 | 20 |
| **R3** | 入口守卫 realpath 修复（含 try/catch）+ `RELAY_ID` + `--preflight` | `relay.ts`、测试 | 无 | `/tmp` 符号链接版实测；删除的 argv[1] 不抛错；preflight 不 listen | 20 |
| **R12** | 抽取 `install-script-command.ts`：`require_command`、命令解析、Node 版本比较、systemd 能力探测；host + relay 生成脚本接入 | 新 `cloud-platform/apps/api/src/install-script-command.ts`、`server.ts`、测试 | 无 | host/relay 文本均用 helper；稀疏 PATH 行为不变；探测结果被 R8/R9 消费 | 20 |
| **R4** | relay 预检：工具、Node 版本、安装根可写、失败码 64/78 | `server.ts`、测试 | R3,R12 | 稀疏 PATH 矩阵 | 15 |
| **R5** | 下载与校验：内容寻址 URL、scheme 参数、缓存、`ORCA_RELAY_BUNDLE`、sha256、65/66 | `server.ts`、测试 | R2,R4 | 篡改/404/离线断言；http 分支无 proto | 20 |
| **R6** | 安全解包与激活：`tar -tvzf` 类型白名单（允许文件/目录，拒 link/device/FIFO/socket/pax）、`--no-same-owner/--no-same-permissions/--no-overwrite-dir`、空目录、真实树复查、原子切换 | `server.ts`、测试 | R5,R3 | 恶意 tar 被拒；目录条目放行；激活幂等 | 20 |
| **R7** | env 写入：原子写、0600、systemd 兼容语法、nonce、`RELAY_ID`/`PORT`/`INTERNAL_TLS_*` | `server.ts`、测试 | R6 | 权限/内容/重跑不丢键 | 15 |
| **R8** | systemd 安装：消费 H10a 模板与 R12 探测结果；`EnvironmentFile` 绝对路径、`current` ExecStart、无 78、StartLimit | `server.ts`、测试 | R7,H10a | 完整 unit 文本断言 | 20 |
| **R9** | 无 systemd：消费 H10b wrapper；nohup/setsid + 实际 pid + 停止/重启 | `server.ts`、测试 | R7,H10b | wrapper source env；pid cmdline 指向 release | 15 |
| **R10a** | nonce 线协议：relay announce 可选 `installNonce` + `/v1/internal/relays` 回显；新旧版本互相兼容 | `relay.ts`、`relay-nodes.ts`/`server.ts`、测试 | 无 | 旧/新两端混用不崩；字段缺失回退 | 20 |
| **R10b** | 自证：MainPID/pid + cmdline/单调时间、nonce、`lastSeenAt` 单位与时钟容差、60s 超时、401 分支 | `server.ts`、测试 | R8,R9,R10a | 旧进程冒名/时钟偏移夹具不误判 | 20 |
| **R11a** | 安装锁 + 同 sha 幂等复用 + `previous` 不被同 sha 覆盖 | `server.ts`、测试 | R10b | 连跑两次断言 | 15 |
| **R11b** | 升级/回滚：新 sha 切换、失败自动回滚、保留 N-1 | `server.ts`、测试 | R11a | 坏包回滚恢复 online | 20 |
| **R13a** | 容器基建 I：Debian 12 + Node 22.18 镜像、构建脚本、临时 HOME、宿主平台可达探测 | `cloud-platform/test/e2e/` 夹具/脚本 | 无 | 镜像自检；无 Orca/仓库源码 | 20 |
| **R13b** | 容器基建 II：运行器、证据采集（releases 树/脱敏 env/进程树/平台 JSON）、skip 门禁 | e2e 夹具/脚本 | R13a | 夹具可在 CI 无 Docker 时显式跳过 | 15 |
| **R13c** | 容器正向 e2e：one-liner → online + §6.2 全部证据断言 | e2e 测试 | R11b,R13b | §6.2 全断言 | 20 |
| **R14a** | 容器负向 I：N1 篡改 / N3 404 / N4 无 Node | e2e 测试 | R13c | 失败码与无副作用 | 20 |
| **R14b** | 容器负向 II：N2 平台不可达 / N6 401 | e2e 测试 | R13c | 68/70 可区分 | 15 |
| **R14c** | 容器负向 III：N5 启动即退出回滚 / N7 并发 | e2e 测试 | R13c,R11b | 回滚恢复；一次 0 一次 75 | 20 |
| **R14d** | 容器负向 IV：N8 无 systemd | e2e 测试 | R13c | nohup 分支 online；不谎称持久 | 15 |
| **R15** | 下载缓存清理：只保留 current/previous 的 tgz、7 天失败残留清理 | `server.ts`、测试 | R11b | 清理后重跑仍命中缓存 | 10 |

共 **22 令**（计数不变）。关键路径：`R1→R2→R5→R6→R7→{R8,R9}→R10b→R11a→R11b→R13c→R14c`；无前置令 `R3`、`R10a`、`R12`、`R13a` 可并行先行；`R12→R4`、`R13a→R13b` 是链内串行，不是可并行对；`R8/R9` 被 H10a/H10b 阻塞。

依赖图（v3）：

```
R12 ─ R4 ─┐
R1 ─ R2 ──┴─ R5 ─ R6 ─ R7 ─ R8 ─┐
R3 ────────────────────────┘   R9 ─┤
H10a ───────────────────────── R8 │
H10b ───────────────────────── R9 │
R10a ─────────────────────────────┴─ R10b ─ R11a ─ R11b ─ R13c ─ R14c
R13a ─ R13b ─────────────────────────────────────────────┘
R11b ─ R15
R13c ─ {R14a, R14b, R14c, R14d}
```

---

## 8. 开放问题（v3）

| # | 问题 | v3 结论/默认 | 影响 |
| --- | --- | --- | --- |
| Q1 | 是否在包内附带 Node 运行时？ | **不带**：要求系统 Node ≥22.18，预检失败给 64 与安装指引 | 带 Node 会变成按架构分发；目标 fleet 若普遍无 Node 再单独立项 |
| Q2 | bundle 端点是否需要鉴权？ | **公开（默认结论，不再是开放问题）**：包内无密钥，sha 由管理员脚本钉死；根信任见 §2.2。若安全评审要求隐藏源码，改短期签名 URL + `no-store` | 鉴权形态影响 R2 路由注册位置 |
| Q3 | 默认安装根？ | **`$HOME/.orca-cloud/relay`**（无需 sudo）；`ORCA_RELAY_ROOT=/opt/...` 时要求可写 | 修正「默认 `/opt` + user unit」的隐性 sudo 前提 |
| Q4 | 中继身份？ | **新增 `RELAY_ID`**，默认 `${hostname}:${port}`，首次写入后保持稳定 | 不新增则同端口多中继互相覆盖，自证不可靠 |
| Q5 | 升级/回滚策略？ | **不自动升级**；重跑即升级；保留 N-1，失败自动回滚并退出 70 | 与 host 的显式重跑语义一致 |
| Q6 | 包外清单是否对外发布？ | **不发布**：只在服务端生成 `relay.sh` 时读盘 | 避免多一条需要鉴权的公开路由 |

---

## 9. 评审处理表（v1 评审 P0/P1 + v2 评审 B1/B2/B3）

| 编号 | 评审意见 | 处理 | 落点 |
| --- | --- | --- | --- |
| **P0-1** | `current` 符号链接使 `import.meta.url` 与 `process.argv[1]` 不等，主块不执行、静默 exit 0 | **采纳**：入口守卫双侧 `realpathSync` 比较；`ExecStart` 继续用 `current`；测试覆盖 `/tmp` 前缀与叶子符号链接 | §0.1、§3.1、R3 |
| **P0-2** | `VERSION` 自引用 sha 与确定性构建矛盾，`builtAt` 破坏复现 | **采纳**：包内 `VERSION` 仅 `schemaVersion`+`relayCodeVersion`；`bundleSha256` 写包外清单；`builtAt` 可选、不参与 sha | §2.4、R1 |
| **P0-3** | unit 缺 `EnvironmentFile`，第 11 步必然 70 | **采纳**：给出完整模板，`EnvironmentFile=<ROOT>/relay.env` 绝对路径，R8 文本断言 | §3.2、R8 |
| **P1-1** | `tar -tzf` 看不到条目类型；安全检查不充分 | **采纳**：`tar -tvzf` 类型白名单（拒 link/device/FIFO/socket）+ `--no-same-owner --no-same-permissions` + 空目录 + 解包后真实树复查 | §3 步骤 5/6、R6 |
| **P1-2** | 自证可被同 id 旧进程冒名；无 pid/MainPID；`lastSeenAt` 单位与时钟容差未写 | **采纳**：systemd `MainPID` + cmdline/单调时间；nohup pid 文件 + cmdline；可选 nonce 回显；明确 `lastSeenAt` 毫秒 epoch 与 skew 容差 | §3.3、R10a/R10b |
| **P1-3** | R12 与 U181 H9/H10 归属冲突；U182 b2 未做 `RestartPreventExitStatus` | **v3 修正**：R12 改为抽取 helper 并归 U183（B1）；unit/wrapper 归 H10a/H10b；host unit 的 78 由 H10a 加，relay unit 不加 | §5、R12/R8/R9 |
| **P1-4** | R2 缺包存放/命名/sha 映射契约；路由鉴权未定 | **采纳**：定义 `ORCA_RELAY_BUNDLE_DIR`、`relay-bundle-<sha>.tgz` + `.manifest.json`、sha→文件直映射、503/500 判定、bundle 路由公开且绕过 `/install/*` 鉴权、`relay.sh` 保持 `no-store` | §2.5、R2 |
| **P1-5** | R13/R14/R11 的 20 分钟不可信；无容器基建 | **采纳**：R13 拆 3 令（基建 I/II + 正向），R14 拆 4 令，R11 拆 2 令；新增 R15；共 22 令 | §7 |
| **P1-6** | bundle 端点威胁模型应是结论而非开放问题 | **采纳**：§2.2 写成根信任结论；Q2 收敛为公开默认 | §2.2、§8 Q2 |
| P2-1 | §1.2.6「安装 user unit」措辞与代码不符 | **采纳**：改为「只打印，不安装」 | §1.2.6 |
| P2-2 | 同 sha 重跑把 `previous` 重写为同一 sha | **采纳**：仅 sha 变化时更新 `previous` | §3 步骤 8、§4.2、R11a |
| P2-3 | `downloads/<sha>.tgz` 无清理策略 | **采纳**：保留 current/previous 的 tgz，失败残留 7 天清理 | §4.2、R15 |
| P2-4 | R1「恰好 4 项」过脆 | **采纳**：按 import 闭包断言必需集齐全 + 无多余项，`--sort=name` | §2.3、R1 |
| P2-5 | 失败码 70 语义 | **采纳说明**：脚本级专用，不映射 sysexits | §4.1 |
| P2-6 | unit 缺 StartLimit；host/relay 不可硬编码同一份 | **采纳**：模板参数化，relay unit 含 StartLimit、不含 78；H10a 加 host 的 78 | §3.2、§5 |
| P2-7 | 同机多中继共用 env | **采纳**：每个实例独立 `ORCA_RELAY_ROOT` + `PORT`，env 固定 `<ROOT>/relay.env` | §4.2 |
| **B1** | 阻断 R12：U182 b2 无 `require_command`、无 systemd 探测 helper，R12 无可调用目标 | **采纳**：R12 改为「从现有内联片段抽取 helper」（新 `install-script-command.ts`），归 U183 自身且无前置；删除「U182 b2 已落地」表述；U181 v3 归属同步为「helper 由 U183 R12 提供、H9/H10 消费」 | §1.2.7、§5、R12 |
| **B2** | 阻断 R2：`--proto '=https'` 使本地 HTTP 平台 e2e 必失败（症状 65 而非 68） | **采纳**：按平台 URL scheme 生成下载参数；https 加 `--proto '=https' --tlsv1.2`，http（仅本地测试）不加 proto 但保留 sha256 钉死；生产强制 https | §2.2、§3 步骤 3、§6.1、R2 |
| **B3** | tar 类型谓词对目录自相矛盾；目录条目/pax 头未钉死 | **采纳**：只拒 symlink/hardlink/device/FIFO/socket/pax；允许普通文件与目录；构建固定 `--format=ustar` 且只传文件清单 | §2.3、§3 步骤 5/6、§6.1、R1/R6 |
| P2-A1 | `realpathSync(argv[1])` 未包 try/catch | **采纳**：`safeRealpath` 失败回退 `null`，不抛错、不启动 | §3.1、R3 |
| P2-A2 | 清单版本与包内 `VERSION` 无交叉断言 | **采纳**：R1 机检补「manifest 版本 == VERSION 版本」 | §6.1、R1 |
| P2-A5 | 构建用目录参数会引入 `d` 条目且检查只允许 `-` | **采纳**：并入 B3，显式允许目录、禁止目录参数递归 | §2.3、R1 |
| P2-A6 | 「可并行」表述与依赖表矛盾（R12/R4、R13a/R13b） | **采纳**：改为「无前置令 R3/R10a/R12/R13a 可并行先行；R12→R4、R13a→R13b 链内串行」 | §7 |

---

## 10. 待审表

| 评审轮 | 对象 | 结论 | 状态 | 日期 |
| --- | --- | --- | --- | --- |
| v1 评审（`u183-design-review.md`） | v1（`f34e2c437a8`） | CHANGES-REQUIRED → v2 处理 3 P0 / 6 P1 / 7 P2 | 关闭 | 2026-11-17 |
| v2 评审（`u183-v2-review.md`） | v2（`34b8b7991f0`） | 3 P0 实测关闭；B1/B2 阻断、B3+P2 待修 → v3 处理 | **v2 评审 3 P0 关闭，剩 B1/B2 已修**（B3 与 P2-A1/A2/A5/A6 一并修） | 2026-11-17 |

---

## 11. 修订记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1 | 2026-11-17 | 初稿（`f34e2c437a8`），方案 A + 14 令 |
| v2 | 2026-11-17 | 处理评审 3 个 P0、6 个 P1、7 个 P2；入口守卫、VERSION/清单、完整 unit、tar 类型检查、MainPID/nonce、归属裁定、bundle 契约、拆分为 22 令；v1 原文保留于附录 A |
| v3 | 2026-11-17 | 处理 v2 评审：B1 R12 改为抽取 `install-script-command.ts` 并归 U183（删除「U182 b2 已落地」）；B2 下载参数按平台 scheme 生成并生产强制 https；B3 tar 允许目录、拒绝 pax、构建固定 ustar；P2 realpath try/catch、R1 版本交叉断言、并行表述修正；22 令不变；v2 全文保留于附录 B |

---

## 附录 A：v1 原文（提交 `f34e2c437a8`，保留供对照）

> 以下为 v2 修订前原文，未改动；v2 结论以正文为准。

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

---

## 附录 B：v2 原文（提交 `34b8b7991f0`，保留供对照）

> v2 全文；其附录 A 与本文件附录 A 相同，未重复收录。

# U183 设计令 v2 · 中继安装向导必须真正安装并上线中继

- 日期：2026-11-17
- 版本：v2（评审 `cloud-platform/test-reports/u183-design-review.md` 的 CHANGES-REQUIRED 修订）
- 性质：设计（只设计，未改产品代码）
- v1 基线：`f34e2c437a8`（原文保留在附录 A）
- 输入：`defect-ledger.md` U183、`deployment-real-link.md` §0/§2/§3、`u181-host-mode-design.md` v3、`cloud-platform/apps/api/src/server.ts` 的 `relayInstallScript`、`cloud-platform/apps/relay/src/relay.ts`、`cloud-platform/test/e2e/install-wizard.e2e.test.ts`
- 结论：**方案 A——平台下发内容寻址的 relay 源码包（tarball + 包外清单）**；安装脚本完成下载、校验、安全解包、激活、装服务，并以不可冒名的进程身份 + 平台登记自证 `online`。仓库 clone（C）只保留为显式离线/开发逃生口；随 Orca 包分发（B）与容器化（D）本次不采用。
- 复核基线：当前工作树（含未提交的 U182 批 2）。行号会漂移，引用以「文件:符号」为准。

---

## 0. 结论摘要（v2）

| 项 | v2 结论 |
| --- | --- |
| 分发形态 | 平台构建时生成确定性源码 tarball，按 sha256 内容寻址：`/install/relay-bundle/<sha256>.tgz` |
| 版本元数据 | 包内 `VERSION` 只含 `schemaVersion` + `relayCodeVersion`（源码常量）；`bundleSha256` 由发布脚本写入**包外**清单 `relay-bundle-<sha>.manifest.json`；`builtAt` 可选、不参与 sha |
| 入口守卫 | `relay.ts` 主块改用 `realpathSync(process.argv[1])` 与 `realpathSync(fileURLToPath(import.meta.url))` 比较；`current` 符号链接安装后可正常执行（P0-1） |
| 校验 | sha256 在管理员生成的 `relay.sh` 中内嵌并钉死；下载后再比对；包外清单只用于生成命令，不参与目标机信任链 |
| 安装位置 | 默认 `$HOME/.orca-cloud/relay`（无 sudo）；`ORCA_RELAY_ROOT` 可指向 `/opt/orca-cloud/relay`；env 固定为 `<ROOT>/relay.env` |
| 运行时 | 目标机需 Node ≥22.18（`cloud-platform/package.json:14`）；包内无需 `node_modules` |
| 激活 | 解包到 `releases/<sha>/`，原子切换 `current` 符号链接；按 sha 变化保留 N-1 供回滚 |
| 守护 | 有 user systemd 则装 unit 并 `enable --now`；否则 wrapper + nohup + pid 文件 |
| unit 契约 | 必含 `EnvironmentFile=<ROOT>/relay.env`；`ExecStart=<NODE> <ROOT>/current/apps/relay/src/relay.ts`；不含 `RestartPreventExitStatus=78`（该键属 host unit，由 H10a 加） |
| 自证 | systemd 用 `MainPID` + 进程 cmdline/启动单调时间；nohup 用 pid 文件 + cmdline；另加可选 `installNonce` 回显。`lastSeenAt` 是平台毫秒 epoch，只用于平台侧 `online`，不与目标机墙钟直接比较 |
| 幂等 | 同 sha 复用 release 与下载缓存；只有 sha 变化才更新 `previous`；失败自动回滚 |
| 归属 | 命令预检/systemd 探测复用 U182 批 2；unit 模板、linger、无 systemd wrapper 归 U181 H10a/H10b；U183 只保留 relay 安装编排 |
| 拆分 | 22 令，全部 ≤20 分钟；容器基建与负向场景已拆开（见 §7） |

### 0.1 两个必须先说清的命名陷阱

1. Orca 安装包里的 `out/relay/`（`config/electron-builder.config.cjs:102-127`）是**桌面 SSH 中继资产**（`relay.js`、`relay-watcher.js`、WSL relay 等），与云平台的 `cloud-platform/apps/relay` **不是同一个东西**。U183 不得复用 `out/relay`。
2. 当前 `relay.ts:688` 的入口守卫是 `if (import.meta.url === \`file://${process.argv[1]}\`)`。Node 默认对主模块取 realpath，而 `process.argv[1]` 保留符号链接路径，因此任何路径段是符号链接都会让主块不执行、进程 exit 0。v2 把修复钉死在 R3，见 §3.1。

---

## 1. 现状与缺口（修正措辞）

### 1.1 脚本实际做了什么

`server.ts:451` `relayInstallScript()` 生成的脚本只有四段：

| 位置 | 动作 | 事实 |
| --- | --- | --- |
| `server.ts:460-466` | 检查 `node` | 仅 `command -v node`，不校验版本；注释写明「本脚本不安装中继运行时」 |
| `server.ts:467-472` | 检查中继入口 | 要求 `$ORCA_RELAY_ROOT/cloud-platform/apps/relay/src/relay.ts` 已存在；不存在即 exit 1 |
| `server.ts:474-484` | 写 `relay.env` | `ORCA_CLOUD_API_URL`、`ORCA_CLOUD_INTERNAL_TOKEN`、`PORT`、`RELAY_PUBLIC_HOST` |
| `server.ts:486-496` | 平台健康检查 | 有界、不跟重定向、只认 2xx（U182） |
| `server.ts:498-536` | **只打印** | 打印 `node relay.ts`、systemd unit 文本或 nohup 命令，**不执行** |

全脚本没有 `curl` 下载（`curl` 只用于 `/health`）、没有 `tar`、没有 `sha256`、没有 `cp/install`、没有 `systemctl enable`。缺陷台账 U183 的「无下载、无安装、无服务创建」与代码一致。

### 1.2 目标机前提与代码事实

1. **入口是 TypeScript，且跨目录相对导入**：`relay.ts:10` `import { mtlsFetch } from '../../../packages/contract/src/internal-fetch.ts'`，`relay.ts:11` `./sni.ts`。释放目录必须保留 `apps/relay/src` 与 `packages/contract/src` 的相对层级。
2. **没有 npm 依赖**：`cloud-platform/package.json` 没有 `dependencies`，`internal-fetch.ts` 只 import `node:fs`/`node:https`。包不需要 `pnpm install`。
3. **Node 版本是硬前提**：`cloud-platform/package.json:14` `"node": ">=22.18"`，即默认启用 type stripping 的版本。
4. **注册即自证**：中继 listen 后先 `refresh()`（`relay.ts:660-668`），成功后 `announce()`（`relay.ts:340-344,348-377`）向 `POST /v1/internal/relay-endpoint` 报到；平台按 30s 窗口判 `online`（`relay-nodes.ts:7`、`server.ts:4581-4592`）。
5. **默认 id 会撞车**：未显式给 `id` 时平台用 `relay:${port}`（`relay-nodes.ts:58`），同端口的多台中继会互相覆盖。自证必须能唯一识别本机中继。
6. **当前默认安装根不可写风险（修正）**：脚本默认 `/opt/orca-cloud`，却**打印** user systemd unit（`server.ts:507-518`），并不安装；真实矛盾是「要求代码在 `/opt`」+「给出 user unit 文本」+「env 写到 `$HOME`」三者不一致。v1 §1.2.6 的「却安装 user unit」措辞已删除，当前代码不安装任何 unit。

### 1.3 验收缺口

`deployment-real-link.md:61` 把「Node ≥22.18 + 仓库代码（或镜像）」列为中继机前置，`:72` 却承诺管理台一键命令。现状等于把「把仓库放到 `/opt/orca-cloud`」这件未写入任何步骤的事留给操作者。U182 容器回归（`evidence/u182-b2-regress-20261117T170856/`）在预检阶段即退出，没有创建任何中继服务。

---

## 2. 方案与包契约

### 2.1 候选与取舍（结论不变）

| 案 | 形态 | 结论 |
| --- | --- | --- |
| **A** | **平台下发源码 tarball**：脚本从平台下载 `.tgz`，校验 sha256，解包到安装根，装服务 | **推荐** |
| B | 随 Orca 安装包分发云中继 | 否：与客户端发版耦合，中继机通常不装桌面 Orca |
| C | 仓库 clone/依赖已装 | 仅显式逃生口，脚本不执行 `git clone`/`pnpm install` |
| D | 容器化 | 否：中继机前提里没有容器运行时，多一个高权限守护进程 |

保留的逃生口：`ORCA_RELAY_BUNDLE=/path/to/relay-bundle-<sha>.tgz`（离线/气隙，仍校验内嵌 sha）与 `ORCA_RELAY_ROOT` 指向既有解包目录（仅开发，见 §2.5）。

### 2.2 信任模型（v2 写成结论）

根信任 = **HTTPS + 管理员/一次性下载令牌 + `relay.sh` 内嵌 sha256**。

- 内容寻址 + 内嵌 sha 能防传输篡改与 MITM（TLS 前提下）。
- **不能**防平台被攻陷：脚本与包同源，攻陷平台者可同时替换二者。
- **不能**防 `relay.sh` 本身被篡改：一次性令牌的 one-liner 仍是 `curl -fsSL`（`install-wizard.e2e.test.ts:78`），应补 `--proto '=https'`（R2）。
- 包内无任何密钥，因此 bundle 端点**公开**是默认结论，不再作为开放问题（Q2 收敛，见 §8）。

### 2.3 构建产物与目录

新增 `cloud-platform/scripts/build-relay-bundle.mjs`：

```
$OUT/relay-bundle-<bundleSha256>.tgz
$OUT/relay-bundle-<bundleSha256>.manifest.json
```

- `$OUT` 默认 `cloud-platform/var/relay-bundles`（gitignore），可用 `ORCA_RELAY_BUNDLE_OUT` 覆盖。
- tarball 根（必需集 = `VERSION` + `relay.ts` 的 import 闭包）：

```
VERSION
apps/relay/src/relay.ts
apps/relay/src/sni.ts
apps/relay/src/relay-version.ts
packages/contract/src/internal-fetch.ts
```

- 不含 `node_modules`、`.git`、证书、env、测试、文档。包内**无任何密钥**。
- 确定性构建：固定 mtime/uid/gid/permissions，`tar --sort=name`，gzip `-n`；同一输入两次构建的 tgz 字节与 sha 相同。文件清单按 import 闭包断言「必需集齐全 + 无多余项」，不再写死「恰好 4 项」。

### 2.4 版本与 sha 契约（P0-2）

**包内 `VERSION`**（由源码常量生成，不含包自身 sha）：

```json
{"schemaVersion":1,"relayCodeVersion":"0.1.0"}
```

- `schemaVersion`：bundle 布局/安装脚本契约版本，布局不兼容时递增。
- `relayCodeVersion`：中继源码版本，来自新文件 `cloud-platform/apps/relay/src/relay-version.ts` 的导出常量；`relay.ts` 在启动日志打印它。
- **不放 `bundleSha256`**：包内文件不能包含包含它自身的 tarball 的 sha（不动点不存在）。
- **不放 `builtAt`**：构建时刻会破坏二次构建同 sha；若发布流程需要审计时间，只写包外清单。

**包外清单** `relay-bundle-<bundleSha256>.manifest.json`（发布脚本在 tgz 定稿后写入，不在 tarball 内）：

```json
{
  "bundleSha256": "<64 位小写 hex，等于文件名中的 sha>",
  "schemaVersion": 1,
  "relayCodeVersion": "0.1.0",
  "files": ["VERSION", "apps/relay/src/relay.ts", "..."],
  "builtAt": "2026-11-17T09:30:00Z"
}
```

- `bundleSha256` 对 tarball 原始字节计算，与文件名、URL、`relay.sh` 内嵌值三方一致。
- `builtAt` **可选**，不参与 sha、不参与清单相等性判断；测试只比较 `bundleSha256`/`schemaVersion`/`relayCodeVersion`/`files`。
- 清单**不**对外提供下载；只在平台生成 `relay.sh` 时从磁盘读取。

### 2.5 平台存放与路由契约（P1-4）

**存放**：

| 项 | 契约 |
| --- | --- |
| 目录 | `ORCA_RELAY_BUNDLE_DIR`，默认 `<repo>/cloud-platform/var/relay-bundles` |
| 包文件 | `<DIR>/relay-bundle-<sha>.tgz` |
| 清单文件 | `<DIR>/relay-bundle-<sha>.manifest.json` |
| sha 校验 | 请求路径只接受 `^[0-9a-f]{64}$`；不接受 basename 以外的任何路径段 |
| sha→文件 | 直接拼 `<DIR>/relay-bundle-<sha>.tgz`；不做目录扫描、不做「最新版本」猜测 |
| 当前版本 | 不定义「当前」；管理员生成命令时显式选择构建产物，sha 即版本 |

**生成 `relay.sh` 的判定**（`server.ts` 的管理员/下载令牌分支）：

1. 目标 sha 的 `.tgz` 不存在 → `503 RELAY_BUNDLE_UNAVAILABLE`，**不生成注定失败的脚本**；
2. `.tgz` 存在但 `.manifest.json` 缺失 → `500 RELAY_BUNDLE_MANIFEST_MISSING`（部署错误）；
3. 清单中的 `bundleSha256` 与请求 sha 不符 → `500 RELAY_BUNDLE_MANIFEST_INVALID`；
4. 通过后把 sha、`schemaVersion`、`relayCodeVersion`、URL 写入脚本 env。

**路由与鉴权**：

| 路由 | 鉴权 | 缓存 | 说明 |
| --- | --- | --- | --- |
| `GET /install/relay.sh`（及一次性 token 变体） | 管理员或一次性 download token（`server.ts:2384-2427`），用后即焚 | `cache-control: no-store`（`server.ts:2441-2444`） | 含内部令牌，绝不缓存 |
| `GET /install/relay-bundle/<sha>.tgz` | **公开**（包内无密钥；sha 由脚本钉死） | `cache-control: public, max-age=31536000, immutable`；`ETag: "<sha>"` | 必须注册在 `/install/*` 通用鉴权分支**之前**，避免被 admin 门禁误伤 |
| 清单 | 不对外 | — | 仅服务端读盘 |

安全评审若要求隐藏源码，改为短期签名 URL + `no-store`，属于 Q2 的另一分支；默认不采用。

**离线逃生口**：

- `ORCA_RELAY_BUNDLE=/abs/path/relay-bundle-<sha>.tgz`：跳过下载，仍与脚本内嵌 sha 比对；不要求同目录有清单（版本号来自脚本内嵌值）；若同目录存在清单且 `bundleSha256` 不符 → 66。
- `ORCA_RELAY_ROOT` 指向已解包的开发目录：仅开发用，必须同时给 `ORCA_RELAY_ALLOW_UNVERIFIED=1`，脚本打印显著警告；生产预检拒绝该组合（78）。

### 2.6 脚本内嵌值

```sh
ORCA_RELAY_BUNDLE_SHA256=<64 hex>
ORCA_RELAY_BUNDLE_URL=<platform>/install/relay-bundle/<sha>.tgz
ORCA_RELAY_SCHEMA_VERSION=1
ORCA_RELAY_CODE_VERSION=0.1.0
```

运行时契约不变：`node <root>/current/apps/relay/src/relay.ts`，env 仍读 `ORCA_CLOUD_API_URL` / `ORCA_CLOUD_INTERNAL_TOKEN` / `PORT` / `RELAY_PUBLIC_HOST`（`relay.ts:195`、`:693-709`），新增 `RELAY_ID` 与安装 nonce（见 §3、§7 R3/R10a）。

---

## 3. 安装时序（v2）

脚本按以下顺序执行；**任何一步失败都不启动服务**，并在 stderr 给出稳定码。

| # | 步骤 | 细节 | 失败码 |
| --- | --- | --- | --- |
| 1 | 预检工具 | `bash`、`curl`、`tar`、`sha256sum`（macOS 回退 `shasum -a 256`）、`node` 版本 ≥22.18；安装根可写（默认 `$HOME/.orca-cloud/relay`）；复用 U182 批 2 的 `require_command`/systemd 探测 helper | 64 / 78 |
| 2 | 平台健康 | `GET <platform>/health`，5s 连接 / 10s 总超时，不跟重定向，只认 2xx；记录响应 `Date` 头供时钟容差 | 68 |
| 3 | 取得包 | 默认 `curl -fsS --proto '=https' --tlsv1.2` 到 `<ROOT>/downloads/<sha>.tgz.part`；已存在且校验通过则跳过；`ORCA_RELAY_BUNDLE` 时直接使用本地文件 | 65 |
| 4 | 校验 | 对 tarball 算 sha256，与脚本内嵌值逐字节比对；不匹配删除临时文件 | 66 |
| 5 | 安全检查 | `tar -tvzf` 逐条解析类型标记与链接目标：只允许普通文件 `-`；拒绝 symlink `l`、hardlink `h`、block/char device `b`/`c`、FIFO `p`、socket `s`；拒绝绝对路径、`..`、以及白名单外的顶层项；白名单 `VERSION`、`apps/`、`packages/` | 67 |
| 6 | 解包 | 新建空目录 `<ROOT>/releases/<sha>.tmp-$$`；`tar -xzf --no-same-owner --no-same-permissions`；解包后 `find` 真实树再次拒绝一切非普通文件与逃逸路径；校验必需文件存在且为普通文件；原子 `mv` 为 `<ROOT>/releases/<sha>` | 67 |
| 7 | 运行时预检 | 通过**真实 release 路径**执行 `node <release>/apps/relay/src/relay.ts --preflight`（R3 新增）：只解析 env、校验 Node/模块图，不 listen、不发 HTTP、不注册；同时回归符号链接路径（P0-1） | 64 / 78 |
| 8 | 激活 | `ln -sfn` 到临时链接后 `rename` 为 `<ROOT>/current`；**仅当新 sha 与当前 `current` 不同**时把旧目标写入 `<ROOT>/previous`；同 sha 重跑不覆盖 `previous` | 67 |
| 9 | 写 env | 临时文件 + `fsync` + `rename`，`0600`；写入 API URL、内部令牌、`PORT`、`RELAY_PUBLIC_HOST`、`RELAY_ID`、可选 `INTERNAL_TLS_*`、本次安装 nonce；文件为 systemd `EnvironmentFile` 兼容语法（`KEY=VALUE`，无 `export`） | 78 |
| 10a | systemd | 探测 user systemd（复用 U182 批 2）：用 H10a 的参数化模板写 `~/.config/systemd/user/orca-relay.service`；`daemon-reload` + `enable --now`；`loginctl enable-linger` 失败只告警；unit 全文见 §3.2 | 69 |
| 10b | 无 systemd | 用 H10b 的 wrapper 模板写 `<ROOT>/run-relay.sh`（显式 `set -a; . <ROOT>/relay.env; set +a; exec node <ROOT>/current/apps/relay/src/relay.ts`），`nohup setsid` 启动，把**子进程实际 pid** 写入 `<ROOT>/relay.pid`；明示不随开机自启 | 69 |
| 11 | 自证 | 记录本次安装单调起点；按 §3.3 校验进程身份与平台登记；默认 60s 超时 | 70 |
| 12 | 成功输出 | 打印 relay id、`host:port`、`relayCodeVersion`、配置文件路径、停止/回滚命令 | 0 |

补充：先 listen 后同步是 relay 既有语义（`relay.ts:658-668`），平台不可达时进程仍会在 listen 后每 2s 重试（`relay.ts:379-385`）。因此「进程起来了」不等于「上线」，第 11 步必须查平台登记，不能只看 `kill -0`。

### 3.1 P0-1 入口守卫修复（钉死）

`relay.ts:688` 改为：

```ts
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : ''
const modulePath = realpathSync(fileURLToPath(import.meta.url))
if (invokedPath && invokedPath === modulePath) {
  // ... 现有启动主块 ...
}
```

- 两侧都取 realpath，覆盖「路径前缀是符号链接」（如 macOS `/tmp -> /private/tmp`）与「叶子是符号链接」（`current`）两种情形。
- 安装形态选择：`ExecStart`/wrapper **继续指向 `<ROOT>/current/...`**，回滚只切符号链接并重启，不重写 unit。备选的「ExecStart 指向 `releases/<sha>`」需要回滚时重写 unit，v2 不采用；install 时生成 wrapper 的备选也不需要。
- 测试（R3，机检）：
  1. 在 `$TMPDIR` 建 `releases/<sha>/apps/relay/...` 与 `current` 符号链接；`node current/apps/relay/src/relay.ts --preflight` 必须 exit 0 且输出预检标记（证明主块执行，不是静默 exit 0）。
  2. 真实路径 `node releases/<sha>/... --preflight` 同样 exit 0。
  3. 在 `/tmp`（macOS 上本身是符号链接）下重复 1，覆盖路径前缀符号链接。
  4. 负例：`process.argv[1]` 指向不同文件时不执行主块（保持原有「被 import 时不启动」语义）。

### 3.2 unit 模板（P0-3，完整）

`ORCA_ENV_FILE=<ROOT>/relay.env`；`<ROOT>`、`<NODE_BIN>` 在生成时写成绝对路径（不能依赖 `%h`，因为 `ORCA_RELAY_ROOT` 可自定义）：

```ini
[Unit]
Description=Orca Cloud Relay
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
EnvironmentFile=<ROOT>/relay.env
ExecStart=<NODE_BIN> <ROOT>/current/apps/relay/src/relay.ts
WorkingDirectory=<ROOT>/current
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

- **必须**有 `EnvironmentFile=<ROOT>/relay.env`：中继所有配置来自 env（`relay.ts:693-709`），缺它会让 `announce()` 无令牌/无 URL，第 11 步必然 70。
- **不写** `RestartPreventExitStatus=78`：relay 的 `ExecStart` 直接跑 `relay.ts`，正常运行时不会以 78 退出；78 是安装脚本的退出码。该键属于 host unit，由 H10a 生成时加入。
- `StartLimit*` 放 `[Unit]`（systemd ≥229）；老 systemd 由 U182 批 2 探测结果降级为 `Restart=no` 并在输出中告警。
- R8 的文本断言必须覆盖：含绝对 `EnvironmentFile`、`ExecStart` 指向 `current`、不含 `RestartPreventExitStatus=78`、`StartLimitBurst` 存在（systemd 支持时）。

### 3.3 自证判据（P1-2）

**进程身份（不可冒名）**：

| 分支 | 判据 |
| --- | --- |
| systemd | `systemctl --user show -p MainPID --value orca-relay.service` 得到 pid > 0；`/proc/<pid>/cmdline` 的入口 realpath 必须等于 `<ROOT>/releases/<sha>/apps/relay/src/relay.ts`；`systemctl show -p ActiveEnterTimestampMonotonic` 必须 >= 本次安装开始时的单调时间（读 `/proc/uptime`），不受墙钟影响 |
| nohup | `<ROOT>/relay.pid` 中的 pid 必须存活（`kill -0`）；`/proc/<pid>/cmdline` 的入口 realpath 必须指向本次 release；`/proc/<pid>/stat` 的 starttime 换算后必须 >= 本次安装单调起点 |

**nonce（第二证据，跨版本安全）**：

- 第 9 步生成本次安装 nonce，写入 `relay.env` 的 `ORCA_RELAY_INSTALL_NONCE`。
- relay 的 announce 请求体新增**可选** `installNonce` 字段；平台 `/v1/internal/relays` 回显（可选字段，旧服务端忽略、旧中继不发送）。
- 新中继 + 旧平台：平台不回显，脚本回退到进程身份 + `online`，打印一条降级警告。
- 旧中继 + 新平台：无 nonce，脚本同样回退。
- 只有 nonce 匹配（或明确降级）且进程身份匹配，才判定本次安装成功；旧 release 进程以同一 `RELAY_ID` 刷新无法冒名。

**`lastSeenAt` 单位与时钟容差**：

- `lastSeenAt` 是**平台侧毫秒 epoch**（`relay-nodes.ts` 的 `nowMs`），不是秒、不是 ISO 字符串。
- 平台 `online` 判据是 `now - lastSeenAt <= 30_000`（`server.ts:4581-4592`）；脚本只看该布尔值。
- 脚本**不**用目标机墙钟与 `lastSeenAt` 直接比较。若旧平台缺少 nonce 且必须比较，用第 2 步响应的 `Date` 头估算偏移，容差取 `max(5s, |skew| + 2s)`，并在输出中打印 skew。
- 401/403 与超时分开报告：401 输出「内部令牌不匹配」提示；超时输出平台 relays JSON 与日志尾部。

---

## 4. 失败码、幂等与升级/回滚

### 4.1 稳定失败码

| 码 | 名称 | 触发 | 可重试 | 副作用 |
| --- | --- | --- | --- | --- |
| 0 | — | 安装并上线 | — | 服务运行 |
| 64 | `relay_runtime_missing` | 缺 curl/tar/sha256sum，`node` 缺失或 <22.18 | 是（补依赖） | 未写安装根（除 downloads 目录） |
| 65 | `relay_bundle_unavailable` | 下载失败/404/平台 5xx/`ORCA_RELAY_BUNDLE` 不存在 | 是 | 无 |
| 66 | `relay_bundle_checksum_mismatch` | sha256 与内嵌值不符 | 是（重新下载） | 删除坏包 |
| 67 | `relay_bundle_unpack_failed` | tar 非法条目/类型、缺文件、激活失败 | 否（换包） | 保留旧 `current` |
| 68 | `relay_platform_unreachable` | `/health` 非 2xx 或超时 | 是 | 无 |
| 69 | `relay_service_install_failed` | unit 写入/启动、wrapper/nohup 失败 | 视原因 | env 已写，服务未就绪 |
| 70 | `relay_not_online_timeout` | 60s 内未通过自证 | 是（看日志/平台） | 自动回滚（若存在 previous） |
| 75 | `relay_install_busy` | 另一安装进程持锁 | 是 | 无 |
| 78 | `relay_config_invalid` | 安装根不可写、参数/环境冲突、`--preflight` 不过、生产使用未校验目录 | 否 | 无 |
| 1 | 未分类 | 兜底 | 视原因 | — |

注：64–78 是**安装脚本**退出码，不承诺覆盖 sysexits 全部语义；70 取「脚本级超时」含义，不映射 `EX_SOFTWARE`。

### 4.2 幂等

| 场景 | 行为 |
| --- | --- |
| 重跑，同 sha | 命中 `downloads/<sha>.tgz` 与 `releases/<sha>`，跳过下载/解包；原子重写 env（nonce 换新）；`restart` 服务；`RELAY_ID` 不变；**`previous` 不更新** |
| 重跑，新 sha | 新 release 解包 → `previous=current`（仅此处更新）→ `current=新` → 重启；旧 release 保留 |
| 并发执行 | `flock`（无则 `mkdir` 锁）在 `<ROOT>/.install.lock`；拿不到退出 75 |
| env 已存在 | 不删除、不重置；只覆盖本次受管键；`RELAY_ID` 一旦生成则保持稳定 |
| 服务已运行 | 先 `stop`/`TERM` 旧进程，等端口释放再启动；不并存两个中继进程 |
| 平台已有同名 `RELAY_ID` | 注册是 upsert（`relay-nodes.ts:56-67`），覆盖 host/port/lastSeenAt |
| 下载缓存 | 成功后只保留 `current`/`previous` 对应 sha 的 tgz，其余删除；失败时保留临时文件供诊断，超过 7 天清理（R15） |
| 同机多实例 | 每个实例必须使用不同 `ORCA_RELAY_ROOT` 与不同 `PORT`；env 固定 `<ROOT>/relay.env`，不同 root 天然隔离；同 root 多实例不支持 |

### 4.3 升级与回滚

- **升级**由管理员重新生成安装命令并重跑；脚本**不自更新**，中继进程也不轮询新版本。
- 只在 `current` 目标 sha 变化时把旧目标写入 `<ROOT>/previous`；同 sha 重跑保持 previous 不变，避免「回滚到同一版本」的空操作。
- 第 11 步超时（70）且 `previous` 存在：写回 previous 链接，换新 nonce 重启，再等 30s；恢复成功则退出 70 并打印「已回滚到 `<old sha>`，新版本未上线」。
- 回滚后 env 保持；回滚版本忽略未知键（如新 nonce）。
- 成功输出打印一键回滚命令（切回 `previous` 并重启）。
- 保留最近 2 个 release；更旧的由重跑时清理（只删除非 `current`/`previous` 的 `releases/*`）。

---

## 5. 归属裁定：U183 / U182 批 2 / U181 H9-H10（P1-3）

### 5.1 结论

| 能力 | 归属 | U183 的动作 |
| --- | --- | --- |
| `require_command`、命令预检、命令解析 | **U182 批 2（已落地）** | R12 只调用，不新建 `install-script-snippets.ts` |
| systemd 能力探测（user bus、版本、键支持） | **U182 批 2（已落地）** | R4/R8/R9 消费探测结果 |
| user unit 模板、`StartLimit`、linger、无 systemd wrapper | **U181 H10a/H10b** | R8/R9 消费参数化模板；不复制模板实现 |
| host unit 的 `RestartPreventExitStatus=78` | **U181 H10a** | 与 relay 无关；U183 不写该键 |
| relay 安装编排、bundle、校验、激活、自证 | **U183 R1–R11** | 本设计主体 |

### 5.2 三条裁定

1. **R12 缩小**：v1 提出新建 `install-script-snippets.ts` 并抽取 8 个片段，与 U181 v3 §6 的归属表冲突（预检/systemd 探测归 U182 批 2，unit/wrapper 归 H10a/H10b）。v2 **取消**该新模块；R12 只做「relay 脚本接线到 U182 批 2 的预检与命令解析 helper」，估时降至 10 分钟。
2. **unit 生成归 H10a/H10b**：R8/R9 依赖 H10a/H10b 提供的参数化模板/ wrapper 模板；U183 只传 `ExecStart`、`EnvironmentFile`、`WorkingDirectory`、重启策略。排期上 H10a/H10b 先落模板（各 ≤20 分钟），R8/R9 后接。若 H10a/H10b 尚未派工，R8/R9 不得自行写第二份 unit 文本。
3. **`RestartPreventExitStatus` 缺口**：U182 批 2 已落地，但当前 `server.ts` 的 host/relay unit 文本都没有该键（grep 为空）。H10a 生成 host unit 时加入 `RestartPreventExitStatus=78`；**relay unit 不加**（`ExecStart` 是 `relay.ts`，78 是安装脚本的码）。U183 R8 的断言反过来固定「relay unit 不含 78」。

### 5.3 对 U181 文档的修正提示（不属本次改动）

U181 v3 的归属表把「relay 安装/启动」划给 U182 批 2（`:455`），但批 2 实际未实现；该范围由 U183 接管。派工 H9a/H10a 时应同步修正 U181 v3 的归属表与依赖图（仅文档，另令处理）。

---

## 6. 测试与验收（v2）

### 6.1 单元/集成（无容器）

| 项 | 断言 |
| --- | --- |
| 包构建（R1） | 两次构建 tgz sha 相同；`VERSION` 仅 `schemaVersion`/`relayCodeVersion`；不含 `bundleSha256`/`builtAt`；包外清单字段齐全且 sha 与文件名一致；import 闭包无多余项 |
| 版本回归（R1） | 修改 `relayCodeVersion` 常量 → 新 sha、清单新值；修改任一源码字节 → sha 变化；只改 `builtAt` → tgz sha 不变 |
| 生成器（R2） | `relay.sh` 含 sha/url/schemaVersion/relayCodeVersion 与 `--proto '=https'`；缺包 503；缺清单/清单 sha 不符 500；bundle 路由绕过 admin 门禁、返回 immutable；`relay.sh` 仍 `no-store` |
| 入口守卫（R3） | `/tmp` 符号链接前缀 + `current` 叶子两种路径 `--preflight` 均 exit 0 且主块执行；真实路径同样通过；被 import 时不启动 |
| 预检（R4） | 稀疏 PATH：缺 node / node 21 → 64 且安装根无 release；缺 tar/sha256sum → 64 |
| 校验（R5） | 篡改 tarball 一个字节 → 66；`current` 不变，服务未启动；`ORCA_RELAY_BUNDLE` 离线路径同样校验 |
| tar 安全（R6） | 含 symlink/hardlink/FIFO/device、`../`、绝对路径的恶意包 → 67；安装根之外无文件；解包后真实树复查生效 |
| 幂等（R11a） | 同脚本连跑两次：一个 release 被激活、`RELAY_ID` 不变、`previous` 未被同 sha 覆盖、平台登记一条 |
| 升级/回滚（R11b） | 注入「sha 合法但启动即退出」的包 → 70 并回滚到上一版，服务恢复 online；同 sha 重跑不产生假回滚 |
| 守护分支（R8/R9） | unit 含绝对 `EnvironmentFile`、`ExecStart` 指向 `current`、不含 `RestartPreventExitStatus=78`；无 systemctl 写 wrapper 且不谎称开机自启；pid 文件存在且 cmdline 指向本次 release |
| 自证（R10b） | 同 id 旧进程 + 新版本启动失败 → 不判成功；nonce 不匹配 → 不判成功；systemd `MainPID` 指向旧 release → 不判成功；时钟偏移夹具不误判 |
| 版本混用（R10a） | 新中继 + 旧平台：忽略 nonce 回退并警告；旧中继 + 新平台：无 nonce 回退；两端都不崩 |

脚本测试复用 `install-wizard.e2e.test.ts:154` 的 `runInstallScript` 干净 shell 夹具，并扩展为可注入本地 bundle 与假 `systemctl`。现有 U182 relay 断言（`:614-648`）改为新语义：缺 node 是**新增**的 64（现状只断言非零），缺中继代码不再是默认路径，而是 `ORCA_RELAY_BUNDLE` 缺失时的 65。

### 6.2 干净容器验收（正向）

环境：Debian 12 amd64，无 Orca 包、无仓库 checkout、无 `cloud-platform` 源码，仅 bash/curl/tar/sha256sum + Node 22.18；平台可达；空 HOME。

1. 管理员生成 relay 安装命令，目标机执行 one-liner；
2. 脚本退出 0，stdout 含 relay id、`relayCodeVersion`、`host:port`、env 路径；
3. `ps` 中恰一个 `node …/current/apps/relay/src/relay.ts`；无人工启动；
4. 平台 `/v1/relays`（或内部 `/v1/internal/relays`）出现该 `RELAY_ID`，`online=true`，且 nonce/进程身份自证通过；
5. `relay.env` 权限 0600、目录 0700；文件不含 bundle 之外的多余内容；
6. 平台 `/connect` 能把该中继列为回落端点（在有宿主路由时）；
7. 证据：脚本 stdout/stderr、`releases/` 树、`current` 链接、env 脱敏副本、平台 relays JSON、进程树、`MainPID`/pid 文件记录。

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
- 浏览器模式证书签发（沿用既有 `RELAY_BROWSER_*`）；
- Windows 中继机；
- 平台侧多中继调度策略。

---

## 7. 实现拆分（v2，每令 ≤20 分钟）

> 约定：每令独立提交；H10a/H10b 先于 R8/R9；R3 可最先落。时间含测试。

| 令 | 内容 | 主要文件 | 依赖 | 机检点 | 估时 |
| --- | --- | --- | --- | --- | --- |
| **R1** | bundle 构建：确定性 tar、import 闭包、包内 `VERSION`、包外清单（sha/versions） | `cloud-platform/scripts/build-relay-bundle.mjs`、`relay-version.ts`、测试 | 无 | 两次 sha 相同；VERSION 无自引用 sha/builtAt；清单映射正确 | 20 |
| **R2** | 平台下发：bundle 目录契约、公开内容寻址路由绕过鉴权、`relay.sh` 内嵌 sha/versions、503/500 判定、`--proto` | `server.ts`、测试 | R1 | 缺包不生成脚本；路由/缓存/鉴权文本断言 | 20 |
| **R3** | 入口守卫 realpath 修复 + `RELAY_ID` + `--preflight` | `relay.ts`、测试 | 无 | `/tmp` 符号链接版实测；preflight 不 listen | 20 |
| **R12** | 接线 U182 批 2 预检/命令解析 helper（不新建共享模块） | `server.ts`、测试 | U182 b2 | relay 脚本调用已有 helper；现有测试不变 | 10 |
| **R4** | relay 预检：工具、Node 版本、安装根可写、失败码 64/78 | `server.ts`、测试 | R3,R12 | 稀疏 PATH 矩阵 | 15 |
| **R5** | 下载与校验：内容寻址 URL、缓存、`ORCA_RELAY_BUNDLE`、sha256、65/66 | `server.ts`、测试 | R2,R4 | 篡改/404/离线断言 | 20 |
| **R6** | 安全解包与激活：`tar -tvzf` 类型白名单、`--no-same-owner/--no-same-permissions`、空目录、真实树复查、原子切换 | `server.ts`、测试 | R5,R3 | 恶意 tar（link/device/FIFO/..）被拒；激活幂等 | 20 |
| **R7** | env 写入：原子写、0600、systemd 兼容语法、nonce、`RELAY_ID`/`PORT`/`INTERNAL_TLS_*` | `server.ts`、测试 | R6 | 权限/内容/重跑不丢键 | 15 |
| **R8** | systemd 安装：消费 H10a 模板；`EnvironmentFile` 绝对路径、`current` ExecStart、无 78、StartLimit | `server.ts`、测试 | R7,H10a | 完整 unit 文本断言 | 20 |
| **R9** | 无 systemd：消费 H10b wrapper；nohup/setsid + 实际 pid + 停止/重启 | `server.ts`、测试 | R7,H10b | wrapper source env；pid cmdline 指向 release | 15 |
| **R10a** | nonce 线协议：relay announce 可选 `installNonce` + `/v1/internal/relays` 回显；新旧版本互相兼容 | `relay.ts`、`relay-nodes.ts`/`server.ts`、测试 | 无 | 旧/新两端混用不崩；字段缺失回退 | 20 |
| **R10b** | 自证：MainPID/pid + cmdline/单调时间、nonce、`lastSeenAt` 单位与时钟容差、60s 超时、401 分支 | `server.ts`、测试 | R8,R9,R10a | 旧进程冒名/时钟偏移夹具不误判 | 20 |
| **R11a** | 安装锁 + 同 sha 幂等复用 + `previous` 不被同 sha 覆盖 | `server.ts`、测试 | R10b | 连跑两次断言 | 15 |
| **R11b** | 升级/回滚：新 sha 切换、失败自动回滚、保留 N-1 | `server.ts`、测试 | R11a | 坏包回滚恢复 online | 20 |
| **R13a** | 容器基建 I：Debian 12 + Node 22.18 镜像、构建脚本、临时 HOME、宿主平台可达探测 | `cloud-platform/test/e2e/` 夹具/脚本 | 无 | 镜像自检；无 Orca/仓库源码 | 20 |
| **R13b** | 容器基建 II：运行器、证据采集（releases 树/脱敏 env/进程树/平台 JSON）、skip 门禁 | e2e 夹具/脚本 | R13a | 夹具可在 CI 无 Docker 时显式跳过 | 15 |
| **R13c** | 容器正向 e2e：one-liner → online + §6.2 全部证据断言 | e2e 测试 | R11b,R13b | §6.2 全断言 | 20 |
| **R14a** | 容器负向 I：N1 篡改 / N3 404 / N4 无 Node | e2e 测试 | R13c | 失败码与无副作用 | 20 |
| **R14b** | 容器负向 II：N2 平台不可达 / N6 401 | e2e 测试 | R13c | 68/70 可区分 | 15 |
| **R14c** | 容器负向 III：N5 启动即退出回滚 / N7 并发 | e2e 测试 | R13c,R11b | 回滚恢复；一次 0 一次 75 | 20 |
| **R14d** | 容器负向 IV：N8 无 systemd | e2e 测试 | R13c | nohup 分支 online；不谎称持久 | 15 |
| **R15** | 下载缓存清理：只保留 current/previous 的 tgz、7 天失败残留清理 | `server.ts`、测试 | R11b | 清理后重跑仍命中缓存 | 10 |

共 **22 令**。关键路径：`R1→R2→R5→R6→R7→{R8,R9}→R10b→R11a→R11b→R13c→R14c`；`R3`、`R10a`、`R12/R4`、`R13a/R13b` 可并行先行；`R8/R9` 被 H10a/H10b 阻塞。

依赖图（v2）：

```
U182 b2 ─ R12 ─ R4 ─┐
R1 ─ R2 ────────────┴─ R5 ─ R6 ─ R7 ─ R8 ─┐
R3 ──────────────────────┘            R9 ─┤
H10a ────────────────────────────────── R8 │
H10b ────────────────────────────────── R9 │
R10a ──────────────────────────────────────┴─ R10b ─ R11a ─ R11b ─ R13c ─ R14c
R13a ─ R13b ──────────────────────────────────────────────┘
R11b ─ R15
R13c ─ {R14a, R14b, R14c, R14d}
```

---

## 8. 开放问题（v2）

| # | 问题 | v2 结论/默认 | 影响 |
| --- | --- | --- | --- |
| Q1 | 是否在包内附带 Node 运行时？ | **不带**：要求系统 Node ≥22.18，预检失败给 64 与安装指引 | 带 Node 会变成按架构分发；目标 fleet 若普遍无 Node 再单独立项 |
| Q2 | bundle 端点是否需要鉴权？ | **公开（默认结论，不再是开放问题）**：包内无密钥，sha 由管理员脚本钉死；根信任见 §2.2。若安全评审要求隐藏源码，改短期签名 URL + `no-store` | 鉴权形态影响 R2 路由注册位置 |
| Q3 | 默认安装根？ | **`$HOME/.orca-cloud/relay`**（无需 sudo）；`ORCA_RELAY_ROOT=/opt/...` 时要求可写 | 修正「默认 `/opt` + user unit」的隐性 sudo 前提 |
| Q4 | 中继身份？ | **新增 `RELAY_ID`**，默认 `${hostname}:${port}`，首次写入后保持稳定 | 不新增则同端口多中继互相覆盖，自证不可靠 |
| Q5 | 升级/回滚策略？ | **不自动升级**；重跑即升级；保留 N-1，失败自动回滚并退出 70 | 与 host 的显式重跑语义一致 |
| Q6 | 包外清单是否对外发布？ | **不发布**：只在服务端生成 `relay.sh` 时读盘 | 避免多一条需要鉴权的公开路由 |

---

## 9. 评审处理表（P0/P1）

| 编号 | 评审意见 | 处理 | v2 落点 |
| --- | --- | --- | --- |
| **P0-1** | `current` 符号链接使 `import.meta.url` 与 `process.argv[1]` 不等，主块不执行、静默 exit 0 | **采纳**：入口守卫双侧 `realpathSync` 比较；`ExecStart` 继续用 `current`；测试覆盖 `/tmp` 前缀与叶子符号链接 | §0.1、§3.1、R3 |
| **P0-2** | `VERSION` 自引用 sha 与确定性构建矛盾，`builtAt` 破坏复现 | **采纳**：包内 `VERSION` 仅 `schemaVersion`+`relayCodeVersion`；`bundleSha256` 写包外清单；`builtAt` 可选、不参与 sha | §2.4、R1 |
| **P0-3** | unit 缺 `EnvironmentFile`，第 11 步必然 70 | **采纳**：给出完整模板，`EnvironmentFile=<ROOT>/relay.env` 绝对路径，R8 文本断言 | §3.2、R8 |
| **P1-1** | `tar -tzf` 看不到条目类型；安全检查不充分 | **采纳**：`tar -tvzf` 类型白名单（拒 link/device/FIFO/socket）+ `--no-same-owner --no-same-permissions` + 空目录 + 解包后真实树复查 | §3 步骤 5/6、R6 |
| **P1-2** | 自证可被同 id 旧进程冒名；无 pid/MainPID；`lastSeenAt` 单位与时钟容差未写 | **采纳**：systemd `MainPID` + cmdline/单调时间；nohup pid 文件 + cmdline；可选 nonce 回显；明确 `lastSeenAt` 毫秒 epoch 与 skew 容差 | §3.3、R10a/R10b |
| **P1-3** | R12 与 U181 H9/H10 归属冲突；U182 b2 未做 `RestartPreventExitStatus` | **采纳**：R12 取消新模块，只复用 U182 b2 预检/命令解析；unit/wrapper 归 H10a/H10b；host unit 的 78 由 H10a 加，relay unit 不加 | §5、R12/R8/R9 |
| **P1-4** | R2 缺包存放/命名/sha 映射契约；路由鉴权未定 | **采纳**：定义 `ORCA_RELAY_BUNDLE_DIR`、`relay-bundle-<sha>.tgz` + `.manifest.json`、sha→文件直映射、503/500 判定、bundle 路由公开且绕过 `/install/*` 鉴权、`relay.sh` 保持 `no-store` | §2.5、R2 |
| **P1-5** | R13/R14/R11 的 20 分钟不可信；无容器基建 | **采纳**：R13 拆 3 令（基建 I/II + 正向），R14 拆 4 令，R11 拆 2 令；新增 R15；共 22 令 | §7 |
| **P1-6** | bundle 端点威胁模型应是结论而非开放问题 | **采纳**：§2.2 写成根信任结论；Q2 收敛为公开默认 | §2.2、§8 Q2 |
| P2-1 | §1.2.6「安装 user unit」措辞与代码不符 | **采纳**：改为「只打印，不安装」 | §1.2.6 |
| P2-2 | 同 sha 重跑把 `previous` 重写为同一 sha | **采纳**：仅 sha 变化时更新 `previous` | §3 步骤 8、§4.2、R11a |
| P2-3 | `downloads/<sha>.tgz` 无清理策略 | **采纳**：保留 current/previous 的 tgz，失败残留 7 天清理 | §4.2、R15 |
| P2-4 | R1「恰好 4 项」过脆 | **采纳**：按 import 闭包断言必需集齐全 + 无多余项，`--sort=name` | §2.3、R1 |
| P2-5 | 失败码 70 语义 | **采纳说明**：脚本级专用，不映射 sysexits | §4.1 |
| P2-6 | unit 缺 StartLimit；host/relay 不可硬编码同一份 | **采纳**：模板参数化，relay unit 含 StartLimit、不含 78；H10a 加 host 的 78 | §3.2、§5 |
| P2-7 | 同机多中继共用 env | **采纳**：每个实例独立 `ORCA_RELAY_ROOT` + `PORT`，env 固定 `<ROOT>/relay.env` | §4.2 |

---

## 10. 修订记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1 | 2026-11-17 | 初稿（`f34e2c437a8`），方案 A + 14 令 |
| v2 | 2026-11-17 | 处理评审 3 个 P0、6 个 P1、7 个 P2；入口守卫、VERSION/清单、完整 unit、tar 类型检查、MainPID/nonce、归属裁定、bundle 契约、拆分为 22 令；v1 原文保留于附录 A |
