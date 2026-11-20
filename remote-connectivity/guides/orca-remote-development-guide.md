# Orca 远程开发使用文档

> 适用版本：Orca 1.4.x + Ubuntu 24.04 LTS
> 验证环境：`192.168.150.220`（Ubuntu 24.04.4 / 内核 6.8 / glibc 2.39）
> 最后更新：2026-11-03

---

## 1. 架构与概念

```
┌──────────────────────┐        ws://host:6768        ┌─────────────────────────┐
│  Orca 客户端          │  ◄──── E2EE (nacl.box) ────► │  Orca Runtime (服务端)   │
│  macOS / Windows /   │                              │  orca-ide serve          │
│  Web 浏览器 / 移动端   │                              │  监听 0.0.0.0:6768       │
└──────────────────────┘                              └─────────────────────────┘
                                                              │
                                                  终端 / agent / 文件 / git
                                                              │
                                                  工作区: /opt/orca/work 等
```

| 概念                     | 说明                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Runtime（服务端）**    | 无头运行的 Orca，负责所有执行：PTY、agent、文件、git、浏览器                                             |
| **Client（客户端）**     | 桌面 App、Web 页面、移动端；只做展示与输入                                                               |
| **配对链接**             | `orca://pair?code=...`，内含 endpoint、device token、公钥、作用域                                        |
| **作用域 scope**         | `runtime` = 桌面/Web/CLI 可用；`mobile` = 仅移动端（桌面端会拒绝）                                       |
| **监听地址 vs 配对地址** | `serve --port 6768` 监听 `0.0.0.0`（所有网卡都可用）；`--pairing-address` 只决定**配对链接里写哪个地址** |

> **关键认知**：服务端始终监听所有网卡。换网络（局域网 ↔ Tailscale）只需改配对地址，不需要改监听，也不需要重新配对。

---

## 2. 服务端安装

### 2.1 系统要求

| 项    | 要求                                                  |
| ----- | ----------------------------------------------------- |
| 系统  | Ubuntu 22.04 / 24.04（推荐），内核 ≥ 5.15             |
| glibc | **≥ 2.25**（Orca AppImage 需要 `GLIBC_2.23`、`2.25`） |
| 内存  | ≥ 2 GB（每个终端会话约 50–200 MB）                    |
| 磁盘  | ≥ 1 GB 安装 + 工作区空间                              |
| 显示  | **必须有 Xvfb**（Electron 无头运行依赖 X）            |

> ⚠️ CentOS 7（glibc 2.17）**无法原生运行**，只能容器化。详见第 8 节。

### 2.2 安装系统依赖

Ubuntu base 镜像不含 GUI 库，必须补齐：

```bash
apt-get update
apt-get install -y --no-install-recommends \
  xvfb \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libcairo2 \
  libgtk-3-0t64 libpango-1.0-0 libgbm1 libasound2t64 libxss1 libsecret-1-0 \
  libnotify4 libxdamage1 libxcomposite1 libxrandr2 libxkbcommon0 libdrm2 \
  libxfixes3 libxtst6 libxi6 fonts-liberation
```

**校验**（应输出为空）：

```bash
cd /tmp && /path/to/orca-linux.AppImage --appimage-extract >/dev/null
ldd ./squashfs-root/orca-ide | grep "not found"
rm -rf squashfs-root
```

### 2.3 放置 AppImage

```bash
mkdir -p /opt/orca
cp orca-linux.AppImage /opt/orca/
chmod +x /opt/orca/orca-linux.AppImage
```

### 2.4 首次手动验证

```bash
cd /opt/orca
timeout 40 xvfb-run -a -s "-screen 0 1280x1024x24" \
  ./orca-linux.AppImage --appimage-extract-and-run --no-sandbox \
  serve --port 6768 --pairing-address <对外地址>
```

成功输出：

```
Orca server ready
Bound endpoint: ws://0.0.0.0:6768
Advertised endpoint: ws://<地址>:6768
Pairing URL: orca://pair?code=...
```

> 首次启动会解包 200MB AppImage 到 `/tmp/appimage_extracted_*`，约 30–60 秒。

---

## 3. 配置为系统服务

### 3.1 服务单元

`/etc/systemd/system/orca-server.service`：

```ini
[Unit]
Description=Orca runtime server (headless)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=/root
Environment=PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WorkingDirectory=/opt/orca
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1280x1024x24" /opt/orca/orca-linux.AppImage --appimage-extract-and-run --no-sandbox serve --port 6768 --pairing-address 192.168.150.220
Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

**参数说明**

| 参数                         | 作用                           | 注意事项                     |
| ---------------------------- | ------------------------------ | ---------------------------- |
| `--no-sandbox`               | 容器/无特权环境必需            | 有安全代价，见第 7 节        |
| `--appimage-extract-and-run` | 免 FUSE 直接解包运行           | 首次启动慢，之后走缓存       |
| `--pairing-address`          | 配对链接中发布的地址           | 改成局域网 IP / tailnet IP   |
| `Restart=always`             | 崩溃自动重启                   | 配合 `RestartSec=5` 避免风暴 |
| `KillMode=control-group`     | 停止时清理 xvfb-run + orca-ide | **必须**，否则残留进程占端口 |

> ❌ **不要**写 `ExecStart=xvfb-run ...` 且让 `xvfb-run` 成为 PID 1（例如容器 ENTRYPOINT 直接 exec 它）—— 实测 AppImage 会静默不启动。systemd 下 `Type=simple` 已经是子进程模型，不存在此问题。

### 3.2 启用

```bash
systemctl daemon-reload
systemctl enable --now orca-server
systemctl status orca-server
```

### 3.3 启用时的数据目录

| 路径                       | 内容                                                  |
| -------------------------- | ----------------------------------------------------- |
| `/root/.config/orca/`      | 配置、配对设备、E2EE 密钥（约 6.5 MB）                |
| `/root/.local/share/orca/` | 会话数据                                              |
| `/root/.local/bin/orca`    | 首次 `serve` 时自动安装的 CLI                         |
| 工作区                     | 自定义，建议放在独立大容量分区（如 `/opt/orca/work`） |

---

## 4. 生成配对链接

### 4.1 从日志提取

服务每次启动都会打印配对链接：

```bash
journalctl -u orca-server | grep "Pairing URL" | tail -1
```

### 4.2 在服务端生成（推荐）

```bash
ssh root@<host>
orca  # 首次 serve 已自动安装
```

或用 Web 客户端打开 `http://<host>:6768/web-index.html`，页面内可生成新配对。

### 4.3 解码检查

```bash
echo '<code>' | base64 -d
# {"v":2,"endpoint":"ws://...","deviceToken":"...","publicKeyB64":"...","pairedDeviceId":"...","scope":"runtime"}
```

确认：

- `endpoint` 是**客户端能访问到的地址**（不是 `127.0.0.1`）
- `scope` 是 `runtime`（PC/Web/CLI）或 `mobile`（仅移动端）

### 4.4 三种地址形态

| 场景            | `--pairing-address`      | 客户端要求                   |
| --------------- | ------------------------ | ---------------------------- |
| 局域网          | `192.168.150.220`        | 同一网段                     |
| Tailscale       | `100.67.197.59`          | 客户端已加入同一 tailnet     |
| 公网 + 反向代理 | `wss://orca.example.com` | 需 TLS 终止 + WebSocket 升级 |

> **换地址不用重新配对**：token 与地址无关。可直接修改 `orca-environments.json` 里的 `endpoint`，保留 `deviceToken` / `pairedDeviceId`（见 6.3）。

---

## 5. 客户端配置

### 5.1 桌面端（macOS / Windows）

**方式 A：界面导入**

1. 打开 Orca → 状态栏主机切换下拉 → 添加远程主机
2. 粘贴 `orca://pair?code=...`
3. 保存

**方式 B：CLI 导入**（推荐，可脚本化）

```bash
orca environment add --name 150.220 --pairing-code 'orca://pair?code=...'
orca environment list
orca status --environment 150.220
```

期望输出：

```
runtimeReachable: true
runtimeConnectionState: connected
```

> ⚠️ 界面可能不会立即刷新环境列表 —— 列表在「设置刷新」或「点开状态栏主机下拉」时才重新拉取。CLI 能连就说明配置没问题。

### 5.2 管理环境

```bash
orca environment list                          # 列表
orca environment show --environment 150.220    # 详情
orca environment rm --environment 150.220      # 删除
```

> ❌ `orca environment` **没有 rename 命令**。改名 = 删除 + 用同一配对码重新添加；但**会导致环境 ID 变化**，桌面端若开着会留下悬空引用（见 9.1）。

### 5.3 Web 客户端

直接打开（推荐一次成功）：

```
http://<host>:6768/web-index.html#pairing=<urlencoded orca://pair?code=...>
```

无配对参数时也可打开页面手动粘贴。

### 5.4 移动端

移动端需要 **`mobile` 作用域**的配对链接，且只能通过 Orca 的中继服务（`relay.onorca.dev`）连接，不支持直连局域网地址。

---

## 6. 日常运维

### 6.1 常用命令

```bash
systemctl status orca-server        # 状态
systemctl restart orca-server       # 重启（会重新打印配对链接）
journalctl -u orca-server -f        # 实时日志
journalctl -u orca-server --since "1 hour ago" | grep -i error
ss -tln | grep 6768                 # 确认监听
```

### 6.2 健康检查

```bash
# 服务端
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:6768/web-index.html

# 客户端
orca status --environment 150.220
# 需要 runtimeReachable: true / runtimeConnectionState: connected

# 真实 RPC（更快暴露问题）
orca tab list --environment 150.220 --json
```

### 6.3 修改 endpoint（换网络、不换身份）

服务端改 `--pairing-address` 并重启后，客户端仍指向旧地址。**不要删除重加**，直接改：

```bash
# 1. 退出 Orca 桌面端（否则会被内存态覆盖）
osascript -e 'quit app "Orca"'

# 2. 备份并修改
cd ~/Library/Application\ Support/orca
cp orca-environments.json orca-environments.json.bak-$(date +%s)
python3 - <<'EOF'
import json
p='orca-environments.json'
d=json.load(open(p))
for e in d['environments']:
    if e['name']=='150.220':
        e['endpoints'][0]['endpoint']='ws://192.168.150.220:6768'
json.dump(d, open(p,'w'), ensure_ascii=False, indent=2)
EOF

# 3. 验证后重启
orca status --environment 150.220
open -a Orca
```

### 6.4 服务端设备清理

每次启动 `serve` 若生成新配对，`orca-devices.json` 会累积：

```bash
cat /root/.config/orca/orca-devices.json   # 查看
```

删除未使用的 deviceId 条目即可（不会影响正在用的环境）。

---

## 7. 安全建议

### 7.1 不要长期用 root 跑 agent

`--dangerously-skip-permissions` 在 root 下被 Claude Code 拒绝：

```
--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
```

唯一绕过是 `IS_SANDBOX=1`（写入 `~/.claude/settings.json` 的 `env`），但这只是**声明**，不会真的隔离。生产机上更稳妥的做法是建普通用户：

```bash
useradd -m -s /bin/bash jlc
# 工作区 chown 给该用户
```

### 7.2 受限 sudo（如需运维权限）

`/etc/sudoers.d/jlc` 只放明确的子命令 + 白名单服务：

```sudoers
jlc ALL=(root) NOPASSWD: \
  /usr/bin/systemctl status *, /usr/bin/systemctl is-active *, \
  /usr/bin/journalctl, /usr/bin/journalctl *
jlc ALL=(root) NOPASSWD: \
  /usr/bin/systemctl restart ssh, /usr/bin/systemctl restart cron, \
  /usr/bin/systemctl restart orca-server, /usr/bin/systemctl daemon-reload
jlc ALL=(root) NOPASSWD: \
  /usr/bin/docker ps *, /usr/bin/docker logs *, /usr/bin/docker restart *
```

**必须遵守的三条：**

1. **服务名写死** —— `systemctl start *` 等于交出 root
2. **Docker 不放 `run/exec/build/compose`** —— `docker run -v /:/host` 等同 root
3. **用真实路径** —— Ubuntu 上 `ip` 在 `/usr/sbin/ip`；sudo 的 `cmd *` 要求至少一个参数，无参形式需单独列

校验：

```bash
visudo -c -f /etc/sudoers.d/jlc
sudo -l -U jlc
```

### 7.3 网络暴露面

- `6768` 监听 `0.0.0.0` —— 只要能访问该端口就能尝试配对；
- 配对码本身是凭证，**不要提交到仓库或群聊**；
- 对外暴露建议走 Tailscale / VPN / 反向代理 + TLS，不要直接映射公网端口。

---

## 8. 特殊环境

### 8.1 CentOS 7（glibc 2.17）无法原生运行

Orca 需要 `GLIBC_2.23`（`lgamma`）、`GLIBC_2.25`（`getrandom`），并且捆绑的 `agent-browser-linux-x64` 需要到 `GLIBC_2.30`。

**不要升级系统 glibc** —— 会破坏 yum/sshd/systemd。

可行方案：

| 方案                 | 风险 | 说明                                               |
| -------------------- | ---- | -------------------------------------------------- |
| Docker（推荐）       | 低   | `--security-opt seccomp=unconfined` 必需（见 8.2） |
| chroot Ubuntu rootfs | 低   | 不碰系统 glibc，性能接近原生                       |
| 新系统双启动         | 低   | 见 `centos7-host-upgrade-plan.md`                  |
| 编译 Chromium        | 极高 | 不现实                                             |

### 8.2 Docker 部署要点

```bash
docker run -d --name orca-server --restart unless-stopped \
  --security-opt seccomp=unconfined \
  --network host \
  -v /opt/orca/work:/workspace \
  -v /opt/orca/state/config:/root/.config/orca \
  -v /opt/orca/state/local:/root/.local/share/orca \
  orca-server:latest
```

**三个必须知道的坑：**

1. **`seccomp=unconfined` 必须带** —— 旧 Docker（如 17.09）的默认 seccomp profile 会拦截 glibc 2.35 的 `statx`/`faccessat2`，导致 `ls` EPERM、apt 的 `test -w` 误判。
2. **数据必须 bind mount** —— devicemapper loop-lvm 上写工作区，`git commit` 慢 **12–25 倍**（实测 689 ms vs 57 ms）。
3. **`xvfb-run` 不能是 ENTRYPOINT 的 PID 1** —— 会静默不启动。entrypoint 应为脚本，`xvfb-run ... "$@" &` + `wait`。

---

## 9. 故障排查

### 9.1 `Unknown environment: <uuid>`

**现象**

```
Error invoking remote method 'runtimeEnvironments:call':
RuntimeEnvironmentStoreError: Unknown environment: fac28095-...
```

**原因**：桌面端持久化状态仍指向已删除的环境 ID（通常是"删除 + 重新添加"导致 ID 变化）。

**修复**（应用必须退出）：

```bash
osascript -e 'quit app "Orca"'

python3 - <<'EOF'
import json, shutil, time
p = 'profiles/local-default/orca-data.json'
shutil.copy2(p, f"{p}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
OLD, NEW = 'fac28095-...', '23ff0d15-...'   # 旧 ID → 新 ID
def remap(o):
    if isinstance(o, dict):  return {k: remap(v) for k, v in o.items()}
    if isinstance(o, list):  return [remap(x) for x in o]
    if isinstance(o, str):   return o.replace(OLD, NEW)
    return o
d = json.load(open(p))
json.dump(remap(d), open(p, 'w'), ensure_ascii=False)
EOF

open -a Orca
```

路径：`~/Library/Application Support/orca/profiles/local-default/orca-data.json`

> 预防：优先**原地改 endpoint**（6.3），不要删除重加。

### 9.2 客户端连不上

按层排查：

```bash
# 1. 服务是否在跑
systemctl is-active orca-server
ss -tln | grep 6768

# 2. 网络是否通
curl -s -o /dev/null -w "%{http_code}\n" http://<host>:6768/web-index.html
ping <host>

# 3. token 是否有效（换个 endpoint 测同一 token）
orca environment add --name _probe --pairing-code '<构造的链接>'
orca status --environment _probe

# 4. 服务端日志
journalctl -u orca-server --since "10 min ago" | tail -50
```

### 9.3 `REMOTE HOST IDENTIFICATION HAS CHANGED`

主机重装或迁移后 SSH 主机密钥变化（这是 SSH 的问题，与 Orca 无关）：

```bash
ssh-keygen -R <host>
ssh-keygen -R <ip>
```

### 9.4 OpenSSH 9.6+ 拒绝 RSA 密钥

Ubuntu 24.04 默认禁用 `ssh-rsa`。若需继续用旧 RSA 密钥，在**服务端** `/etc/ssh/sshd_config.d/` 加：

```
PubkeyAcceptedAlgorithms +ssh-rsa
```

更推荐直接用 ed25519 密钥。

### 9.5 Electron 缺库

```
error while loading shared libraries: libnss3.so: cannot open shared object file
```

回到 2.2 安装依赖，用 `ldd` 逐个确认：

```bash
ldd /tmp/squashfs-root/orca-ide | grep "not found"
```

### 9.6 端口被占 / 残留进程

```bash
ss -tlnp | grep 6768
systemctl status orca-server
# 若确认残留
pkill -f "orca-ide.*serve"
systemctl restart orca-server
```

---

## 10. 主机上的 Claude Code

远程开发的核心用途是跑 agent。服务端配置：

```bash
# 安装（Node 22 + npmmirror）
curl -fL -o /tmp/node.tar.xz \
  https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v22.11.0/node-v22.11.0-linux-x64.tar.xz
mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
for b in node npm npx corepack; do ln -sf /opt/node/bin/$b /usr/local/bin/$b; done
npm config set registry https://registry.npmmirror.com
npm install -g @anthropic-ai/claude-code
ln -sf /opt/node/bin/claude /usr/local/bin/claude
```

`~/.claude/settings.json`（示例）：

```json
{
  "alwaysThinkingEnabled": true,
  "effortLevel": "high",
  "autoCompactEnabled": true,
  "skipDangerousModePermissionPrompt": true,
  "env": {
    "ANTHROPIC_BASE_URL": "https://<proxy>/api",
    "ANTHROPIC_AUTH_TOKEN": "<token>",
    "ANTHROPIC_MODEL": "<model>",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "500000",
    "CLAUDE_STREAM_IDLE_TIMEOUT_MS": "240000",
    "API_TIMEOUT_MS": "3000000",
    "DISABLE_AUTOUPDATER": "1"
  }
}
```

验证：

```bash
claude -p "reply with exactly: OK"
```

> `ANTHROPIC_MODEL` 若使用非 Claude 模型名，会打印 `[claude-code:unrecognized_model]` 警告但**不影响调用**。

---

## 11. 国内网络配置

| 用途        | 源                                                       | 配置位置                |
| ----------- | -------------------------------------------------------- | ----------------------- |
| apt         | `repo.huaweicloud.com`（实测 9 MB/s，阿里云仅 147 kB/s） | `/etc/apt/sources.list` |
| npm         | `registry.npmmirror.com`                                 | `~/.npmrc`              |
| PyPI        | `pypi.tuna.tsinghua.edu.cn`                              | `/etc/pip.conf`         |
| Node 二进制 | `mirrors.tuna.tsinghua.edu.cn/nodejs-release`            | 手动下载                |
| GitHub      | `https://ghfast.top/<url>`                               | 按需                    |

`/etc/profile.d/cn-mirrors.sh`：

```bash
export npm_config_registry=https://registry.npmmirror.com
export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node/
export GH_PROXY=https://ghfast.top/
```

> npm 10 会校验配置键名，`npm config set disturl` 等会报错 —— 直接写 `~/.npmrc`。

---

## 12. 部署检查清单

**服务端**

- [ ] glibc ≥ 2.25（`ldd --version`）
- [ ] GUI 依赖齐全（`ldd orca-ide | grep "not found"` 为空）
- [ ] AppImage 可执行
- [ ] 手动 `xvfb-run ... serve` 能打印 `Orca server ready`
- [ ] systemd 服务 `enabled` + `active`
- [ ] `KillMode=control-group` 已设置
- [ ] `--pairing-address` 是客户端可达地址
- [ ] 防火墙放行 6768（或仅限内网）

**客户端**

- [ ] `orca environment add` 成功
- [ ] `orca status --environment <name>` → `connected`
- [ ] `orca tab list --environment <name>` 正常返回
- [ ] 界面能看到主机（必要时刷新下拉或重启应用）

**运维**

- [ ] 配对码妥善保管，未入库
- [ ] 工作区所在磁盘容量充足
- [ ] 日志轮转（journald）已配置
- [ ] 有回滚/备份方案

---

## 13. 快速命令速查

```bash
# ── 服务端 ──
systemctl status|restart|stop orca-server
journalctl -u orca-server -f
journalctl -u orca-server | grep "Pairing URL" | tail -1
ss -tln | grep 6768

# ── 客户端 ──
orca environment add --name <n> --pairing-code '<url>'
orca environment list|show|rm
orca status --environment <n>
orca tab list --environment <n> --json

# ── 连通性 ──
curl -s -o /dev/null -w "%{http_code}\n" http://<host>:6768/web-index.html
ping <host>

# ── SSH ──
ssh-keygen -R <host>
```

---

## 附：相关文档

- [`analysis/centos7-host-upgrade-plan.md`](../analysis/centos7-host-upgrade-plan.md) —— CentOS 7 → Ubuntu 24.04 迁移全过程与踩坑
- [`analysis/remote-terminal-scrollback-loading-optimization.md`](../analysis/remote-terminal-scrollback-loading-optimization.md) —— 终端历史加载优化
- [`analysis/remote-terminal-load-diagnostics.md`](../analysis/remote-terminal-load-diagnostics.md) —— 加载耗时诊断日志
