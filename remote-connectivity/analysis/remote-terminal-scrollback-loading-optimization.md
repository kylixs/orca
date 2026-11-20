# 远程终端 / Agent Tab 打开时滚动缓冲加载 —— 现状分析与优化方案

| 项       | 值                                                             |
| -------- | -------------------------------------------------------------- |
| 现象     | 打开远程终端 / Claude tab 时需等待较久才能上滚查看历史         |
| 影响面   | 桌面(web/Electron) + 移动端；tailnet 直连与 relay 均同路径     |
| 目标     | 显著缩短"可上滚"的等待时间，并降低大窗口下的传输量与截断       |
| 本文范围 | 用户提出的 **1（分屏拉取）+ 2（压缩）**；**3（本地缓存）暂缓** |

---

## 1. 现状机制（已核实）

### 1.1 端到端流程

```text
客户端打开远程终端 tab
  └─ terminal.subscribe  ──────────────────────────────►  宿主机
        （首帧含 capabilities；后续可发 SnapshotRequest）
  ◄── SnapshotStart(meta JSON)                            │
  ◄── SnapshotChunk(payload × N)   ← 48KB/帧              │
  ◄── SnapshotEnd                                         │
  （字节流 = E2EE 加密；xterm 以 "reset + 重放" 整块写入）
```

### 1.2 关键事实（含位置）

| 关注点                   | 事实                                                                                                                              | 位置                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 两个方法                 | **`terminal.multiplex`**（现代二进制流，桌面+移动都用）与 legacy `terminal.subscribe`（JSON/lease 客户端）                        | `terminal/terminal-multiplex-method.ts:14`                                          |
| 请求参数                 | `SnapshotRequest { requestId?, scrollbackRows? }` —— **只有行数，无偏移/范围**                                                    | `terminal/stream-schemas.ts:36`                                                     |
| **初始推流深度（关键）** | **订阅帧不带 `scrollbackRows`，深度由宿主机阶梯决定**：`[1000, 500, 250, 100, 25, 0]` 行，**512 KiB** 预算 —— 即初始最多 ~1000 行 | `terminal/terminal-snapshot-publication.ts:250`、`scrollback-limits.ts:8`           |
| 客户端按需请求           | 仅在**隐藏面板恢复**与**gap 重同步**时发 `SnapshotRequest`；桌面隐藏恢复 = **配置深度或 5000 默认**，预算 **2 MiB**               | `terminal-hidden-restore-scrollback.ts:8-13`、`terminal-snapshot-publication.ts:21` |
| 恢复/重同步量            | 1000 行                                                                                                                           | `shared/terminal-multiplex-flow-control.ts:11`                                      |
| 客户端重组上限           | 2 MiB                                                                                                                             | `remote-runtime-terminal-snapshot-state.ts:13`                                      |
| 宿主机字节预算           | 桌面 **2 MB**；移动 **512 KB**                                                                                                    | `terminal/terminal-snapshot-publication.ts:21`、`main/runtime/scrollback-limits.ts` |
| 降级候选                 | `[请求值, 1000, 500, 250, 100, 25, 0]` —— **静默丢弃更早历史直到入预算**                                                          | `terminal/terminal-stream-replay.ts:197`                                            |
| 分帧                     | 48 KB/帧                                                                                                                          | `shared/terminal-multiplex-flow-control.ts:1`                                       |
| 快照类型                 | `kind: 'scrollback' \| 'resized'`（**已有"历史帧"概念**）                                                                         | `terminal/terminal-stream-types.ts:12`                                              |
| 传输                     | **nacl.box（X25519 + XSalsa20-Poly1305，AEAD）**                                                                                  | `shared/e2ee-crypto.ts:34`                                                          |
| 压缩                     | **全链路无压缩**，且 WS 压缩被**显式关闭** `perMessageDeflate: false`                                                             | `rpc/relay-transport.ts:68`、`shared/remote-runtime-subscription-transport.ts:225`  |
| 客户端可按帧预算         | `terminal.subscribe` 带 `snapshotByteBudget`（web 端受 bridge 帧上限 ~640KB 约束）                                                | `shared/rpc-contract/terminal-stream-params.ts:22-52`                               |
| 移动端初始量             | **`MOBILE_SUBSCRIBE_SCROLLBACK_ROWS = 1000`**（桌面为 5000）                                                                      | `main/runtime/scrollback-limits.ts:7`                                               |
| 上滚增量加载             | **不存在**，一次性全量                                                                                                            | —                                                                                   |
| 客户端缓存               | **不存在**；移动端**每次开 tab / 切 tab / resize 重排 / 重连都全量重取**                                                          | `mobile/src/session/use-mobile-session-tab-switching.ts:44-53`                      |

### 1.3 为什么"等得久"——四个成本中心（含一个被忽视的大头）

1. **宿主机序列化**：`serializeAuthoritativeTerminalBuffer` 走 HeadlessEmulator 把 N 行重放成 ANSI（CPU 随行数线性）。
2. **⭐ durable 历史回放（最大的隐性成本）**：daemon 的**实时 RAM 窗口仅 1000 行**（`daemon-session-scrollback-window.ts:9`）；**一旦请求 >1000 行，就要从磁盘回放** checkpoint + history log 到一个 5000 行的 HeadlessEmulator（`daemon-pty-buffer-snapshots.ts` 的 `overlayDurableRestoreSnapshot`，**5s 期限**；历史日志上限 5 MiB）。**桌面的"隐藏面板恢复"默认就请求 5000 行 → 每次切回 tab 都可能触发磁盘回放**，这才是"等比较久"的头号来源，且与传输量无关。
3. **传输**：最多 **2 MiB** 密文，分 ~43 帧；本就无压缩。
4. **客户端重放**：xterm 以"reset + 重放"整块写入 N 行，逐字符解析（纯 JS，最慢的 CPU 项）。

> 关键判断（修正）：**初始推流其实已被宿主机阶梯限制在 ~1000 行 / 512 KiB**，并非无界"全量"。真正的"慢"来自两处 ——
> (a) **隐藏面板恢复 / 深请求路径请求 5000 行 → 触发 daemon 磁盘回放**；
> (b) 1000 行仍要全量重放。
> 因此优化要把"**初始/恢复窗口**"一并压到几屏，才同时命中 (a)(b)。

### 1.4 用户假设核实：**两个都成立**

#### (A) "打开终端没有立即加载历史" —— 成立，有两个独立机制

1. **冷/热 parking**：隐藏面板会被"停放"，回来时**重新挂载并回源取快照**。
   - 冷停放延迟 **30s**、热保留 **5min / 6 个 tab（或 4 个 worktree）** | `terminal-pane/terminal-hidden-view-parking.ts:15-22`
   - 代码内注释直接承认成本：**"Reveal cost is a flat ~170ms remount regardless of buffer size, so cutting remount frequency beats shaving replay."**（`:12-14`）——即 **Orca 团队已知这是热点，选择了"降频"而非"降载荷"**。
2. **激活延迟挂载（activation-deferred）**：切到某 worktree 时**只有当前面板立即挂载**，其余 tab **每空闲帧挂载一个**；即非活动 tab 的（含快照的）挂载被**推迟到切换之后** | `components/terminal/use-activation-deferred-tab-admission.ts`（"one per idle frame"）

→ 打开/切回终端时"要等"，部分是这两种"重新挂载 + 回源取快照"造成的，**与快照大小无关的固定开销**。

#### (B) "往前滚动也不加载" —— 成立，且比预想更彻底

- **原生终端根本没有"上滚加载"**：全仓库搜索 `loadOlder` / `loadEarlier` / 分页游标，**唯一实现存在于 Native Chat（Chat UI / 结构化会话）** | `components/native-chat/native-chat-live-session-contract.ts:40`、`use-structured-chat-live-session.ts:15,47`
- **终端侧无对应能力**：没有 opcode、没有 RPC、没有渲染层逻辑。更关键的是 —— **协议里根本没有"请求更早历史"的参数**（`SnapshotRequest` 只有 `scrollbackRows`，无 `beforeSeq`/游标/偏移）。
- 因此：**比初始快照更早的历史，从终端客户端"根本无法取到"**。上滚只是走进 xterm 本地缓冲；到达 `baseY` 后**不存在任何触发加载的路径**。

> **结论**：终端是"**取一次、到此为止**"模型 —— 深度由宿主机一次性阶梯决定，之后不再增长。用户感知的"打开慢 + 上滚无历史"**完全对应**上述两个机制。这也正是 **P1（`beforeSeq` 增量）** 要补的能力；而 (A) 的"重新挂载回源"是另一条正交路径。

---

## 2. 优化一：初始窗口 = 3–4 屏 + 上滚增量加载

### 2.1 窗口有界化（低风险，先做）—— 需分两处改

**（a）初始推流**：订阅帧目前**不带 `scrollbackRows`**，深度由宿主机阶梯决定（起点 1000）。两种做法：

- **A1（推荐，纯宿主机）**：把阶梯起点与预算下调到 ~4 屏，例如 `[200, 100, 50, 25, 0]` + 更小预算。**无需协议改动**，但影响所有客户端。
- **A2（更可控）**：给 `TerminalMultiplexSubscribeFrame` 增加**可选** `scrollbackRows`（订阅帧已有 `capabilities` 结构，新可选字段安全），客户端按 `clamp(viewportRows*4, 80, 400)` 请求；宿主机仍以阶梯兜底。

**（b）隐藏面板恢复（命中最大成本）**：桌面 `resolveHiddenRestoreScrollbackRows` 默认 **5000 行** → 触发 daemon **磁盘回放**。改为视口相关值（如 `viewportRows*4`，上限 ~1000 以避开回放阈值）：

```ts
// terminal-hidden-restore-scrollback.ts
resolveHiddenRestoreScrollbackRows() = clamp(viewportRows * 4, 80, 1000)
```

- 收益：**避开 1000 行阈值以上的 durable 回放**（1.3 的第 2 项），并把序列化/传输/重放同时降到 ~1/5～1/25。常态"看最近几屏"**瞬时可见**。
- 风险：想"一上来翻很深"的用户需多滚一次（由 2.2 增量覆盖）。
- **受益方主要是桌面**：移动端**已是 1000 行**（`MOBILE_SUBSCRIBE_SCROLLBACK_ROWS`）；桌面的 5000 行恢复才是主要对象。
- **移动端另有一个延迟源**（不在本文 1/2/3 范围，记录备查）：宿主机 headless 模型缺失时会先等桌面 renderer 挂载，**上限 3s**（`terminal-legacy-subscribe-snapshot.ts:18`）。

### 2.2 上滚增量加载（核心，需协议扩展）

用户滚到已加载历史顶部时，按页取更早的一页，**prepend** 到 xterm 滚动缓冲之上。

- **锚点用 `seq`，不用行号**：实时输出会在下方追加、导致行号漂移；`seq`（宿主机输出序号，快照已携带）在流上稳定。
- **复用现有 `kind: 'scrollback'` 帧**：历史帧概念已存在，无需新 opcode。
- **协议扩展（additive 可选字段，符合 AGENTS.md "新可选字段是安全的"）**：

  ```ts
  SnapshotRequest {
    requestId?: number
    scrollbackRows?: number          // 现有
    beforeSeq?: number               // 新增：取该 seq 之前的一页（锚点稳定）
    pageRows?: number                // 新增：本页行数
  }
  ```

- 宿主机侧：在 `serializeBudgetedRequestedSnapshot` 增加"按 `beforeSeq` 定位行区间"的分支，复用现有 `kind:'scrollback'` 发布路径（`sendSnapshotFrames`）。
- 客户端侧：`kind:'scrollback'` 帧走 **prepend** 路径写入 xterm 滚动缓冲；`SnapshotStart`/`End` 元数据不变。
- 终端到达缓冲起点（宿主机保留上限，桌面 xterm 50k）时置"已到最早"。
- **移动端收益放大**：移动端**每次切 tab / 重连都全量重取**（无 delta 通道）。有界初始窗口 + 增量对移动端的体验改善比桌面更明显。

### 2.3 兼容性

- 旧客户端：不发 `beforeSeq` → 宿主机按现有全量路径，行为不变。
- 新客户端 × 旧宿主机：宿主机忽略未知字段 → 客户端按"无增量"降级（只显示初始窗口）。**graceful**。
- 无需 capability 协商（可选字段），但客户端应以宿主机是否回 `kind:'scrollback'` 判定增量可用。

---

## 3. 优化二：压缩（inside E2EE，capability 协商）

### 3.1 硬约束：必须压缩在 E2EE **之内**

传输是 **XSalsa20 流密码 + Poly1305**（`e2ee-crypto.ts`）。**密文不可压缩**，因此：

- ❌ WebSocket `permessage-deflate`：压缩的是密文，**零收益**。
- ❌ 传输层压缩：同上。
- ✅ **应用层、加密前压缩**：宿主机 `deflate(data)` → `encrypt()`；客户端 `decrypt()` → `inflate()`。

### 3.2 压缩哪里、用什么

- **压缩对象**：`SnapshotChunk` 的载荷（大块 ANSI）。`SnapshotStart` 元数据保持 JSON。
- **算法**：`deflateRaw`（原始 DEFLATE，无 zlib/gzip 头，最省）。
  - 桌面 / web / Electron：Node `zlib` 现成。
  - **移动端 RN/Hermes 无内置 zlib** → 需纯 JS（`pako`）或原生模块。**建议桌面先上，移动端后续**。
- **预期压缩比**：终端输出重复度极高（提示符、转义序列、TUI 重绘、空白）→ gzip/deflate 通常 **4–10×**。
- **被低估的一点（实证）**：载荷里**每个 ESC 字节在序列化时会被转义约 6×** —— 512 KiB 的屏幕序列化后可达 **669 KB**（`mobile/src/session/terminal-snapshot-byte-budget.web.ts` 的注释即因此设限）。这种转义填充**恰好是压缩最擅长的**，所以真实压缩比往往比纯文本估算更高。压缩同时直接**缓解 web 端 640 KB bridge 帧上限**导致的降级。

### 3.3 必须 capability 协商（硬性要求：老客户端走原始格式）

**原则：压缩是"能力协商后启用"，绝不是默认行为。老客户端（无此能力位）必须继续收到原始格式。**

改变 `SnapshotChunk` 载荷语义会让**旧客户端把压缩字节当 ANSI 渲染**（乱码 / 崩溃）。因此握手必须显式分叉：

| 客户端                       | 是否声明能力                                  | 宿主机行为                                                             |
| ---------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| **旧客户端**（不认识该字段） | 不声明（字段缺失）                            | **原样发原始 ANSI** —— 行为与今天完全一致，零回归                      |
| **新客户端**                 | 订阅帧 `capabilities.snapshotCompression = 1` | 每帧先压缩再加密，并在 `SnapshotStart` 标 `compression: 'deflate-raw'` |

- **能力位加在订阅帧 `capabilities`**（该结构已存在：`ackOutput` / `outputPause` / `inputAck` …），天然是"客户端声明、宿主响应"的方向。
- **判定必须"客户端显式声明"而非"宿主默认开启"**：缺失字段 = 老客户端 = 原始格式。
- `SnapshotStart` 的 `compression` 字段**可选且加性**：老客户端忽略未知字段；新客户端读"缺失"= 未压缩（AGENTS.md Rule 1）。
- **混合版本是常态**（AGENTS.md）：新客户端 × 旧宿主 → 宿主不认能力位 → 回原始格式 → 客户端按原文处理；旧客户端 × 新宿主 → 不声明 → 原文。**四种组合都安全。**
- **绝不能**反过来做（宿主默认压缩、靠客户端"声明不支持"来关）—— 那会让老客户端第一时间收到压缩字节。默认必须是**关**。

### 3.4 与优化一的关系（重要）

两者打**不同区间**：

|          | 优化一（有界窗口）   | 优化二（压缩）                |
| -------- | -------------------- | ----------------------------- |
| 主收益   | **首屏时间**（常态） | **深历史传输**、缓解 2MB 截断 |
| 触发场景 | 每次 attach          | 滚得深 / 大 backlog           |

**结论：先做优化一**（收益最大、风险最低、协议可零改动）；优化二在有界窗口下常态收益有限，但对"深历史"和"避免静默截断"仍有价值，作为第二阶段。

### 3.5 扩展到文件内容与全部文本传输（回答"能否压缩终端 + 文本文件"）

**能，而且有一个出奇干净的单一收口点。**

#### 关键：`encryptBytes` 同时覆盖两条路径

`src/shared/e2ee-crypto.ts`：

```ts
export function encrypt(plaintext: string, sharedKey) {          // 字符串 RPC 走这里
  return Buffer.from(encryptBytes(new TextEncoder().encode(plaintext), sharedKey)).toString('base64')
}
export function encryptBytes(plaintext: Uint8Array, sharedKey) { // 二进制帧走这里
  const nonce = nacl.randomBytes(...); const ciphertext = nacl.box.after(plaintext, nonce, sharedKey)
  return nonce ‖ ciphertext
}
```

因为 **`encrypt()` 内部就是调用 `encryptBytes()`**（`e2ee-crypto.ts:34-37`），所以在 `encryptBytes` / `decryptBytes` 一对函数里"加密前压缩、解密后解压"，**一次性覆盖**：

| 覆盖对象                                                                                | 路径                                                               |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **文本文件内容**（`fs:readFile` / `fs:readFileChunk`）、`files.read`、markdown/diff/log | `encrypt()` → `encryptBytes()`                                     |
| **终端 scrollback / 实时输出**（48KB 二进制帧）                                         | `encryptBytes()`（`remote-runtime-subscription-transport.ts:177`） |
| 其余全部远程 RPC（git、搜索、agent 会话…）                                              | `encrypt()` → `encryptBytes()`                                     |

→ **不必逐功能改**；一个 hook 覆盖全部远程文本流量。

#### 必须处理的 6 个注意点

1. **只能在 E2EE 之内**（密文不可压缩）→ `permessage-deflate` 依旧无效（且已显式关闭）。
2. **按消息压缩，非整段**：终端快照先按 48KB 分块再逐块 `encryptBytes`（`sendSnapshotFrames` → 传输层），**每块独立压缩会损失跨块冗余**（DEFLATE 窗口 32KB）。终端行内重复度高，仍有效；**要最优比，需在分块前先压整段**（功能级 hook，`sendSnapshotFrames` 内）。
3. **base64 膨胀**：字符串 RPC 是 `明文 → 密文 → base64`（`encrypt` 返回 base64，膨胀 33%）。**先压明文**能同时缩小密文与其 base64。
4. **必须能力协商**：旧端无法解压 → 订阅/握手帧加能力位（与 3.3 同一机制）；无能力位则明文。
5. **阈值 + "压不小就不压"**：小于 ~1KB 跳过；`png/jpg/zip` 等已压缩数据压缩后反而更大 → 保留"只有更小才用"的兜底。**文本/日志/JSON/diff/markdown 收益最大**。
6. **移动端另有一套 E2EE**（`mobile-e2ee-v2` 的 `sealBinary`/`openBinary`），需单独 hook；且 **RN/Hermes 无内置 zlib**（同 3.2）。

#### 收益判断

- **文本文件 / 日志 / diff / JSON / markdown**：压缩比通常 **4–10×**，且能顺带**避开 4 MiB 明文上限**（`MAX_E2EE_TEXT_PLAINTEXT_BYTES`）。
- **终端**：见 3.2 的"ESC 转义约 6×"实证，收益高于纯文本估算。
- **二进制已压缩资产**（图片/压缩包）：**无收益**，靠阈值与"更小才用"跳过。

---

## 4. 优化三（本地缓存）—— 暂缓，理由

用户已判断有风险，核实后认同，补充具体原因：

- **滚动缓冲内容不稳定**：`clear`、TUI 全屏重绘、alt-screen（Claude/Codex 等 TUI）会重写/覆盖屏幕，**"逻辑行号"或内容哈希都难以稳定匹配**。
- 用户设想的"不缓存最后一屏"是**正确的最小缓解**，但仍无法覆盖 alt-screen 切换、`clear`、光标相对定位重绘等。
- 现阶段收益不如优化一直接，**建议待优化一落地、观测真实回滚模式后再评估**。

---

## 5. 分期与工作量

| 阶段     | 内容                                                           | 协议改动          | 风险 | 工作量      |
| -------- | -------------------------------------------------------------- | ----------------- | ---- | ----------- |
| **P0**   | 窗口有界化（2.1 两处：初始阶梯 + 隐藏恢复窗口）                | 无（走 A1）       | 低   | 小（≤0.5d） |
| **P1**   | 上滚增量：`beforeSeq`/`pageRows` + `kind:'scrollback'` prepend | 可选字段          | 中   | 中（1–2d）  |
| **P2**   | `deflate-raw`（capability 协商），桌面/web 先行                | 可选字段 + 能力位 | 中   | 中（1–2d）  |
| **正交** | 停放/延迟挂载策略（1.4）：降低"重复回源"频率；不改协议         | 无                | 低   | 小          |
| —        | 移动端压缩（pako/原生）                                        | —                 | 中   | 另计        |

> **正交项说明**：1.4 的 parking / activation-deferred 是**与快照大小无关的固定开销**，Orca 现有注释已承认（约 170ms/次重挂载）。P0 只降"每次取多少"，降不了"取几次"；两者叠加才完整。可先观测重挂载频率是否值得单独优化。

---

## 6. 验证方案

- **指标**：attach → 首帧可交互时间（TTFP）、单次快照字节数、宿主机序列化耗时。
- **回归**：Tailscale 直连（用户当前路径）与 relay 路径都要跑。
- **场景**：普通 shell、长输出日志、Claude/Codex TUI（alt-screen）、`clear` 后重连。
- **必测回归（对应 1.4）**：
  - **切走 30s+ 再切回**同一终端（触发冷停放重挂载）→ 观察是否再次全量取快照、耗时多少。
  - **切到一个多 tab worktree** → 观察非活动 tab 是否被 activation-deferred 推迟挂载、历史何时出现。
  - **滚到 xterm 顶部**（`baseY`）→ 确认**当前确实不触发任何加载**（作为 P1 的基线证据）。
- **兼容**：新客户端 × 旧宿主机、旧客户端 × 新宿主机各跑一遍（AGENTS.md 混合版本是常态）。
- **既有测试**：`remote-runtime-terminal-*.test.ts`、`terminal-multiplex-*`、`mobile-subscribe-idle-pane-hydrate`。

---

## 7. 结论

1. **优化一（有界窗口 + 上滚增量）是主杠杆**：常态首屏立刻可见，且 P0 阶段**零协议改动**即可上线见效。
2. **优化二（压缩）必须做在 E2EE 之内**，且需 capability 协商；在有界窗口下是"深历史 / 防截断"的补充，二期做。
3. **优化三暂缓**：滚动缓冲语义不稳定，收益不如优化一，待观测后再议。
