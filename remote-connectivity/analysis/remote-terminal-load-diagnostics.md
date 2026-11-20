# 远程终端加载诊断日志 —— 开启 / 查看 / 分析

配套代码：`feat/remote-terminal-load-diagnostics` 分支。用于定位"打开远程终端 / agent tab 要等多久、卡在哪一段"。

---

## 1. 埋了什么

一次"打开/恢复终端"会在客户端（renderer）按顺序产生 4 条面包屑，名称前缀统一为 `remote_terminal_load_timing`：

| `phase`      | 含义                                 | 关键字段                                                                 |
| ------------ | ------------------------------------ | ------------------------------------------------------------------------ |
| `subscribed` | 客户端**发出**订阅帧（T0）           | `streamId`、`terminal`                                                   |
| `start`      | 收到 `SnapshotStart`（宿主开始推送） | `target`、`scrollbackRows`、`truncated`、`cols`、`rows`                  |
| `received`   | 收到 `SnapshotEnd`（字节全部到达）   | `chunks`、`bytes`、`requestMs`、`firstByteMs`、`receiveMs`、`transferMs` |
| `applied`    | 快照已重放进 xterm                   | `seq`、`chars`、`carriesHistory`                                         |

`target` 区分三种加载：

- `initial` —— 打开 tab / 首次订阅
- `request` —— **隐藏面板恢复**（对应分析文档 1.3 的 daemon 磁盘回放大头）
- `recovery` —— 流损坏后的重同步

### 各耗时字段的含义（决定瓶颈归因）

```
subscribed ──requestMs──► start ──firstByteMs（含）──► received ──► applied
    T0                    SnapshotStart              SnapshotEnd
```

- **`requestMs`** = T0 → `SnapshotStart`。这是**宿主的自有成本**：序列化 +（若请求 >1000 行）**daemon 磁盘回放**。
  - 若这里大 → 瓶颈在**宿主**，压缩/分页都救不了，要降窗口（优化一 2.1）。
- **`firstByteMs`** = T0 → 首片到达 = `requestMs` + **首片网络 RTT**。
- **`transferMs`** = 首片 → 末片 = **纯传输**（wire + E2EE）。
  - 若这里大 → 压缩（优化二）有效。
- **`applied` - `received`** = 快照落地到 xterm 的**重放耗时**（纯客户端 CPU）。
  - 若这里大 → 优化一（减行数）有效；压缩无关。

> 组合判定：`requestMs` 大 = 宿主；`transferMs` 大 = 带宽/体积；两者都小但用户仍觉得慢 = **重放**。

---

## 2. 如何开启

日志**默认关闭**，无常态开销。开启方式（在**出现问题的那个客户端**上执行）：

### 桌面 / Electron 客户端

DevTools 控制台（`View → Toggle Developer Tools`）执行一次：

```js
localStorage.setItem('orca:remote-terminal-load-timing', '1')
```

关闭：

```js
localStorage.removeItem('orca:remote-terminal-load-timing')
```

> 设置持久，重启仍在；分析完记得关。

### Web 客户端（浏览器直连 runtime）

在该页面的 DevTools 控制台执行**同样一行**（`localStorage` 按 origin 隔离，所以要对**具体那个 runtime 的页面**执行）。

### 移动端（Android / iOS）

移动端是**另一套埋点**（RN 侧，不能用 `localStorage` / `window.api`）：

- **开关**：无独立开关，受 **`__DEV__`** 控制（`metro.config.js` 决定）。开发/HMR 包默认输出；生产包静默。要临时在生产观察，临时改 `__DEV__` 判定或加一个持久化开关。
- **查看**：`console.log`，标签统一为 **`[terminal-diagnostic]`**。用 `adb logcat`（Android）或 Metro/RN debugger 过滤该标签。
- **埋点事件（一次加载的时序）**：

| 事件                         | 含义                                | 关键字段                                       |
| ---------------------------- | ----------------------------------- | ---------------------------------------------- |
| `stream-armed`               | 发出订阅（T0）                      | `seq`、`hasViewport`、`viewportCols/Rows`      |
| `stream-first-event`         | 首个流事件（通常 `subscribed`）     | `type`、**`elapsedMs`**（T0→首帧 = 宿主+网络） |
| `stream-scrollback-received` | 收到 `serialized` 快照              | `serializedLength`、**`elapsedMs`**            |
| `stream-scrollback-applied`  | `ref.init()` 返回（已重放进 xterm） | **`elapsedMs`**                                |
| `stream-first-data`          | 首条实时数据（加载完成，结束计时）  | **`elapsedMs`**                                |

- **归因**（与 PC 同逻辑）：
  - `first-event.elapsedMs` 大 → **宿主**（序列化 / durable 回放）
  - `scrollback-received` 与 `scrollback-applied` 之差大 → **客户端重放**（WebView xterm）
  - `first-data.elapsedMs` ≈ 全程 → 总量
- **实现位置**：`mobile/src/session/mobile-terminal-load-timing.ts`（计时类）、`mobile-terminal-diagnostic-log.ts`（日志原语）、`mobile-terminal-diagnostics.ts`（组合，`streamArmed`/`firstDataAfterHydration` 为入口）、调用点在 `use-mobile-session-terminal-subscription.ts`。

---

## 3. 如何查看（复现 + 取日志）

1. 开启开关（第 2 节）。
2. **复现**：打开一个远程终端 / agent tab；或**切走 30s 以上再切回**（触发冷停放重挂载）。
3. 取日志，任选：

### 方式 A：实时看（DevTools 控制台）

埋点写入崩溃面包屑通道，最直观的是让它打印到控制台。若当前构建的控制台未直接可见，用方式 B/C。

### 方式 B：导入诊断包

Orca 的崩溃/诊断面包屑会随**诊断报告**一起导出。触发一次诊断导出（`Settings → 诊断` 或对应菜单），在生成的 JSON 里搜 `remote_terminal_load_timing`。

### 方式 C：直接从运行时读崩溃面包屑

`recordRendererCrashBreadcrumb` 最终走 `window.api.crashReports.recordBreadcrumb`。在 DevTools 里可直接回读最近的面包屑（若你的构建暴露了 `window.n()` / 诊断读取接口）。

> 每次复现都会追加**新**的 4 条记录；用 `streamId` + `terminal` 把同一次加载的 4 条串起来。

---

## 4. 如何分析（把日志映射到瓶颈）

针对**同一次**加载（相同 `streamId`/`terminal`），按 `phase` 取齐 4 条，然后：

| 观测                                     | 结论                                                | 对应优化                                         |
| ---------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| `requestMs` 大（几百 ms ~ s）            | 宿主序列化 / **daemon 磁盘回放**                    | **优化一**：降窗口到 1000 行以下（避开回放阈值） |
| `transferMs` 大、`bytes` 大              | 传输体积                                            | **优化二**：E2EE 内压缩                          |
| `applied` − `received` 大                | 客户端重放（xterm CPU）                             | **优化一**：减行数；压缩无效                     |
| `target === 'request'` 且 `requestMs` 大 | **隐藏面板恢复触发了回放**（分析文档 1.3 头号成本） | 优化一 2.1(b)                                    |
| `truncated: true`                        | 宿主因预算**丢弃了更早历史**                        | 优化二（压缩）+ 优化一（窗口）                   |
| 只有 `subscribed` 无后续                 | 订阅发出但宿主未回——连接/握手问题                   | 另查 E2EE/网络                                   |

**典型判读示例**：

- `requestMs≈5ms, transferMs≈40ms, applied−received≈450ms` → 浪费在**重放**；把初始窗口从 1000 行降到 4 屏即可大幅改善。
- `requestMs≈1200ms`（`target: request`）→ 命中 **daemon 回放**；把隐藏恢复窗口降到 ≤1000 行。
- `transferMs≈900ms, bytes≈500KB` → 带宽受限；压缩收益最大。

---

## 5. 相关实现位置

| 关注点                              | 文件                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 埋点模块（开关、四阶段、字段）      | `src/renderer/src/runtime/remote-terminal-load-timing.ts`                                                   |
| 帧到达埋点（Start/Chunk/End/apply） | `src/renderer/src/runtime/remote-runtime-terminal-binary-snapshots.ts`                                      |
| 订阅发出埋点（T0）                  | `src/renderer/src/runtime/remote-runtime-terminal-multiplexer-implementation.ts`                            |
| 单测                                | `src/renderer/src/runtime/remote-terminal-load-timing.test.ts`                                              |
| **移动端**计时类                    | `mobile/src/session/mobile-terminal-load-timing.ts`                                                         |
| **移动端**日志原语                  | `mobile/src/session/mobile-terminal-diagnostic-log.ts`                                                      |
| **移动端**组合/入口                 | `mobile/src/session/mobile-terminal-diagnostics.ts`（调用点 `use-mobile-session-terminal-subscription.ts`） |
| 背景分析                            | `remote-connectivity/analysis/remote-terminal-scrollback-loading-optimization.md`                           |

---

## 6. 注意事项

- 开关关闭时**不产生任何记录**（`isRemoteTerminalLoadTimingEnabled()` 提前返回），无常态开销。
- 埋点是 **best-effort**：任何记录失败都被吞掉，绝不影响终端加载。
- 时间戳用 `performance.now()`（单调时钟），字段均为**相对毫秒**，不是绝对时间。
- `bytes` 是**快照组字节累计**（所有 `SnapshotChunk` 之和），与 `received` 的 `requestMs` 同一次加载。
