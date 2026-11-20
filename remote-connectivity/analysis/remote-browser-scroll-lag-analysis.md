# 远程浏览器滚动卡顿分析与优化方案

> 日期：2026-11-10
> 场景：Orca 桌面端在本机托管浏览器，手机/远程客户端通过 paired runtime 观看并操作页面
> 结论：**瓶颈是 RTT、串行输入 RPC 和帧节流，不是带宽**

---

## 1. 现象

远程打开本机页面后：

- 滚动明显卡顿、发涩，页面一跳一跳
- 网络流量不高，链路远未跑满
- 鼠标/键盘等其它操作相对正常，滚动最明显

---

## 2. 实测拓扑

| 项             | 值                                                                   |
| -------------- | -------------------------------------------------------------------- |
| 浏览器位置     | 本机 Mac（`agent-browser`，client-hosted browser）                   |
| 观看端         | 手机 `xiaomi-14`（100.117.240.95）                                   |
| 连接           | 本机 `100.103.213.12:6768` ↔ 手机 `100.117.240.95:44162` ESTABLISHED |
| Tailscale 路径 | 直连（非 DERP）                                                      |
| RTT            | **113ms**                                                            |
| 本机 CPU       | `agent-browser` / Orca renderer 空闲时约 0%，不是 CPU 瓶颈           |

结论：页面渲染在本机，输入和画面都要跨这条 113ms 链路。

---

## 3. 根因

### 3.1 滚动输入串行，每批要等 2 个 RTT（主因）

代码：`src/renderer/src/components/browser-pane/stream-remote/use-remote-browser-page-wheel.ts:54-107`

每个滚动批次：

```text
wheel 事件累积 → requestAnimationFrame → browser.mouseMove RPC → browser.mouseWheel RPC
```

- 两个 RPC **顺序 await**
- `remoteWheelInFlightRef` 保证同一时间只有一批在途
- 下一批必须等上一批的 `mouseMove` + `mouseWheel` 都完成

按 113ms RTT 估算：

```text
每批 ≈ 2 × 113ms = 226ms
滚动更新率 ≈ 4.4 次/秒
```

期间手机上的滚动增量会累积，下一批一次性发出，所以页面表现为“跳一大段”，而不是连续滚动。

另外，`use-remote-browser-page-input.ts:37-41` 用一条全局 Promise 队列串行化所有远程输入，鼠标移动、点击、键盘都会排在滚动前面。

### 3.2 画面帧被合并/节流

代码：

- `src/main/browser/browser-screencast-frame-pacer.ts:37-44`：CDP 是 ACK 驱动，ACK 后才发下一帧
- `src/main/browser/browser-screencast-frame-pacer.ts:97-145`：小于 `minFrameIntervalMs` 的帧只保留最新一帧，中间滚动位置直接丢弃
- `src/main/browser/browser-screencast-frame-budget.ts:9-21`：同一页面的共享帧预算取最严格观看者
  - `quality` / `maxWidth` / `maxHeight` / `everyNthFrame` 取最小值
  - `minFrameIntervalMs` 取最大值

默认预算（`runtime-browser-commands-browser-command-target-params.ts`）：

```text
quality: 70
maxWidth: 1440
maxHeight: 1200
everyNthFrame: 2
minFrameIntervalMs: 0
```

代码中的手机订阅示例（`orca-runtime-browser-screencast-fanout.test.ts:215-232`）：

```text
maxWidth: 975
maxHeight: 844
everyNthFrame: 1
minFrameIntervalMs: 100   # ≈ 10fps
```

如果手机端使用该预算，同一页面的所有观看者都会被限制到约 10fps。每帧还要跨 113ms 链路到达手机，视觉反馈比输入再晚 100ms+。

### 3.3 为什么流量不高

- 输入包只有几百字节，且被 RTT 限速
- 帧率被 `minFrameIntervalMs` / ACK 节流，滚动中间帧被丢弃
- 链路是**延迟受限**，不是吞吐受限；带宽空闲是正常现象

### 3.4 其它放大因素

- `sendBinary` 返回 false 时保留最新帧、50ms 后重试（`browser-screencast-frame-pacer.ts:12,77-95`），会增加滞后
- 超过 paired-runtime 单帧上限的帧会被直接丢弃（`remote-browser-screencast-frame-admission.ts`）
- 手机在弱网/切换网络时 RTT 抖动，滚动会明显恶化

---

## 4. 优化方案

### P0：降低输入 RTT（收益最大）

1. **合并 RPC**
   - 新增 `browser.pointerScroll`（或给 `browser.mouseWheel` 增加坐标参数）
   - 一次 RPC 同时完成定位和滚动，省掉一个 RTT：226ms → 113ms

2. **滚动批次不要串行等待**
   - 允许滚动批次 fire-and-forget，或允许多批在途
   - 用序号/时间戳丢弃过期批次，只应用最新累计增量
   - 避免“上一批没回来，下一批不能发”

3. **指针未移动时跳过 `mouseMove`**
   - 记录上次指针位置；连续滚动且位置不变时只发 wheel
   - 进一步把每批降到 1 个 RTT

4. **输入队列分级**
   - 滚动、鼠标移动、键盘不要共用一条全局队列
   - 滚动优先，避免被高频 mouseMove 阻塞

### P1：滚动期间提升画面反馈

5. **滚动期间临时提高帧率**
   - 检测到连续 wheel 事件时，临时降低该订阅的 `minFrameIntervalMs`（如 100ms → 33ms）
   - 停止滚动 300-500ms 后恢复，避免持续高流量

6. **滚动期间降分辨率/质量**
   - 如需控制带宽：滚动时降到 720p / quality 55，静止后恢复 975×844 / quality 70
   - 编码时间也会下降，进一步降低视觉延迟

7. **共享预算按订阅区分**
   - 当前 `minFrameIntervalMs` 取最大值，一个手机观看者会把桌面端也压到 10fps
   - 改为按订阅独立预算，或至少让“正在主动滚动的订阅”获得更高帧率

### P2：可观测性与兜底

8. **增加诊断指标**
   - `browser.mouseWheel` / `browser.mouseMove` RPC 耗时
   - 每订阅实际 FPS、丢帧数、待发帧数
   - 输入批次合并次数、单批累计 delta

9. **同 LAN 对照**
   - 手机连同一 Wi-Fi/LAN（RTT < 5ms）复测
   - 若滚动变顺，即可确认 RTT 是主因，无需先改帧预算

---

## 5. 验证标准

| 指标       | 目标                                         |
| ---------- | -------------------------------------------- |
| 滚动更新率 | 同 LAN ≥ 30 次/秒；113ms 链路下 ≥ 8-10 次/秒 |
| 单批 RPC   | 1 次（合并后），耗时接近 1×RTT               |
| 视觉延迟   | 输入到画面 < 1.5×RTT + 一帧编码时间          |
| 带宽       | 滚动时允许短时上升，停止后回落               |
| 回归       | 鼠标点击、键盘、拖拽行为不改变               |

验证方法：

```bash
tailscale ping -c 5 100.117.240.95     # 当前 113ms
# 同 LAN 下复测，对比滚动体验
# trace 中查看 browser.mouseWheel / browser.mouseMove RPC 耗时
```

---

## 6. 涉及文件

| 文件                                                                                      | 作用                              |
| ----------------------------------------------------------------------------------------- | --------------------------------- |
| `src/renderer/src/components/browser-pane/stream-remote/use-remote-browser-page-wheel.ts` | 滚动批次、顺序 RPC、在途控制      |
| `src/renderer/src/components/browser-pane/stream-remote/use-remote-browser-page-input.ts` | 全局输入队列                      |
| `src/main/browser/browser-screencast-frame-pacer.ts`                                      | ACK、帧间隔、最新帧保留、背压重试 |
| `src/main/browser/browser-screencast-frame-budget.ts`                                     | 多订阅共享帧预算合并              |
| `src/main/runtime/runtime-browser-commands-browser-command-target-params.ts`              | 默认帧预算参数                    |
| `src/main/runtime/remote-browser-screencast-frame-admission.ts`                           | 单帧大小上限与丢帧                |

---

## 7. 风险

- fire-and-forget 可能导致输入乱序：必须用序号/时间戳丢弃过期批次
- 提高帧率会增加带宽和编码 CPU：用“滚动期间短时提升 + 停止后恢复”控制
- 共享预算按订阅区分会改变多观看者行为：需要回归桌面 + 手机同时观看
- 合并 RPC 涉及运行时协议：注意 paired client/host 版本兼容，新增可选参数或能力协商

---

## 8. 实施记录

| 日期       | 改动                                                                                                            | 状态                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 2026-11-10 | `use-remote-browser-page-wheel.ts`：连续滚动且指针位置未变时跳过 `browser.mouseMove`，每批 RPC 从 2 个降为 1 个 | ✅ 已实现；typecheck、oxlint、stream-remote 118 个测试通过 |

后续待做：

1. `browser.mouseMove + browser.mouseWheel` 合并为单个 RPC（协议新增可选坐标参数）
2. 滚动批次允许非阻塞/多批在途，按序号丢弃过期批次
3. 滚动期间临时提高订阅帧率或降低分辨率
4. 输入队列按滚动/鼠标/键盘分级
