# 让 PC 与移动端同时连接无头 Orca 服务 —— 实施方案

| 项         | 值                                                                        |
| ---------- | ------------------------------------------------------------------------- |
| 目标机     | `root@100.124.255.3`（Ubuntu 24.04，Tailscale IP）                        |
| 受影响服务 | `orca-serve.service`（systemd，`/etc/systemd/system/orca-serve.service`） |
| 改动       | 一处：从 `ExecStart` 去掉 ` --mobile-pairing`                             |
| 风险       | 低（重启该 runtime；不影响 tmux 中的独立 agent）                          |
| 状态       | 执行中                                                                    |

---

## 1. 问题

目标机当前以 `--mobile-pairing` 启动：

```
/opt/orca/orca-linux.AppImage --no-sandbox serve --port 6768 --pairing-address 100.124.255.3 --mobile-pairing
```

`serve` 只签发**一个**配对链接，scope 由 `--mobile-pairing` 决定 → 当前为 `mobile`。PC 端粘该链接会被拒：

> `src/shared/remote-pairing-address.ts:98-103` — `scope === 'mobile'` → `mobile-only`，提示 "Generate a link for another Orca client."

且配对链接**只在 `serve` 启动时签发**，CLI/RPC 均无"给运行中 runtime 补签"入口 → 只能改启动参数并重启。

---

## 2. 分析：scope 的影响面

| 能力                  | `mobile` scope（现状） | `runtime` scope（去掉后） |
| --------------------- | ---------------------- | ------------------------- |
| PC / 浏览器连接       | ❌ 被拒                | ✅ 可用                   |
| 浏览器 Web 客户端 URL | ❌ 不生成              | ✅ 额外生成               |
| 手机连接 / 远程控制   | ✅                     | ✅ 仍可用                 |
| 手机推送通知          | ✅                     | ❌ 失效                   |
| relay                 | serve 本就不提供       | 同样不提供                |

**关键事实**（均已核实）：

- 移动端解析链接**不检查 scope**（`mobile/src/transport/pairing.ts` 无 scope 逻辑；`mobile-socket-wiring.ts:64` 仅透传）。
- PC 端**只接受 runtime scope**。
- **runtime scope 是 PC 与移动端的唯一交集** → 必须去掉 `--mobile-pairing`。
- 手机推送强制 `scope === 'mobile'`（`desktop-push-service.ts` 返回 `not_mobile`）→ **唯一代价是手机推送**。
- `serve` 无法同时签发两个 scope 的链接；无头机无法"PC 用 runtime、手机用 mobile"并存。

---

## 3. 实施方案

### 3.1 改动

```ini
# /etc/systemd/system/orca-serve.service
ExecStart=/opt/orca/orca-linux.AppImage --no-sandbox serve --port 6768 --pairing-address 100.124.255.3
#                                                                                          ^^^ 移除 --mobile-pairing
```

### 3.2 执行步骤

```bash
# 1. 备份 unit
cp /etc/systemd/system/orca-serve.service \
   /etc/systemd/system/orca-serve.service.bak-$(date +%Y%m%d%H%M%S)

# 2. 去掉 --mobile-pairing
sed -i 's/ --mobile-pairing//' /etc/systemd/system/orca-serve.service

# 3. 重载并重启
systemctl daemon-reload
systemctl restart orca-serve.service

# 4. 取配对链接
journalctl -u orca-serve.service -n 60 --no-pager | grep -E "Pairing URL|Web client URL"
```

### 3.3 回滚

```bash
cp /etc/systemd/system/orca-serve.service.bak-<ts> /etc/systemd/system/orca-serve.service
systemctl daemon-reload && systemctl restart orca-serve.service
```

### 3.4 客户端接入

- **PC**：侧边栏 **Add remote server**（"Pair with Orca running on another computer"）或 Settings → Remote Orca Servers → Add Server，粘贴 runtime 链接。
- **移动端**：同一个 runtime 链接也能配对（scope 不拦），但**推送通知不可用**。

---

## 4. 影响面核实

- **重启影响**：该 runtime 的 orca 自有终端会重来一茬。
- **不受影响**：机器上 tmux 中的 `claude` 会话（父进程为 `-bash`，独立于 orca serve）。
- **开机自启**：unit 的 `[Install] WantedBy=multi-user.target` 不变。

---

## 5. 遗留 / 后续

- **手机推送丢失**：若必须保留，需要"双链接"能力（PC 用 runtime、手机用 mobile）。当前无头 `serve` 不具备；属架构缺口，可提 issue。
- **可选增强**：为 headless runtime 增加"按需补签 runtime 链接"的 CLI/RPC 入口，使 scope 无需在启动时二选一。
