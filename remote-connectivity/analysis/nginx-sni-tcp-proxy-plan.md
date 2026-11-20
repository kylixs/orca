# nginx 单端口多域名 HTTPS TCP 透传代理 —— 方案文档

| 项       | 值                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 方案待评审                                                                                                                |
| 场景     | 一个 443 入口代理多个第三方 HTTPS 域名，代理不持有证书，只做 TCP 透传                                                     |
| 结论摘要 | 用 `stream` + `ssl_preread` 按 SNI 分流：白名单内域名透传到对应源站，白名单外指向黑洞；证书与握手全在第三方侧，真正端到端 |
| 依赖     | nginx 开源版 ≥ 1.24（官方包含 `stream` 与 `ssl_preread` 模块）                                                            |
| 不适用   | 客户端走系统 HTTP 代理（CONNECT）、第三方启用 ECH、需要注入 header / 按路径路由                                           |

---

## 1. 背景与目标

**需求**：一个代理入口同时代理多个第三方 HTTPS 域名，代理侧**没有也不该有**这些域名的证书，因此只能做 TCP 层透传，不能终止 TLS。

**目标**：

1. 单端口 443 承载 N 个域名，按客户端发出的 SNI 转发到对应源站。
2. TLS 握手端到端，代理不持有私钥、不参与解密。
3. 未授权域名（含无 SNI 的流量）一律拒绝，不能退化成开放中继。
4. 每个域名可独立增删，变更只改配置并 `reload`。

**非目标**：代理侧无法获得 `Host`/路径、无法加 `X-Forwarded-For`、无法缓存或限流内容——这是透传的固有代价，不是配置遗漏。

---

## 2. 原理与边界

### 2.1 为什么只能在 TCP 层读 SNI

TLS 握手的第一步是客户端发 `ClientHello`，其中明文携带 **SNI（Server Name Indication）**，即客户端想访问的域名。nginx 的 `ssl_preread` 只解析这一段，拿到域名后立即按配置转发**原始字节**，不参与握手。

```text
Client                 nginx (stream)                    Third-party origin
  │  TCP connect:443        │                                   │
  ├────────────────────────►│                                   │
  │  ClientHello(SNI=a.com) │  ssl_preread 读出 "a.com"         │
  ├────────────────────────►│  map → 原始 ClientHello 转发 ──────►│
  │                         │                                   │  完成握手
  │◄────────── TLS handshake 端到端（证书来自 a.com）────────────►│
```

### 2.2 能力与边界

| 能做                             | 不能做                                                   |
| -------------------------------- | -------------------------------------------------------- |
| 按 SNI（含通配）选源站           | 看/改任何 HTTP 内容                                      |
| 端到端 TLS、mTLS、ALPN、会话复用 | 按 Host、路径、Header 路由                               |
| 日志记录 SNI、字节数、会话时长   | 给源站传真实客户端 IP（第三方通常不支持 PROXY protocol） |
| 白名单 + 黑洞拒绝                | 主动健康检查（开源版 stream 仅被动摘除）                 |
| 按 SNI 统计与告警                | 终止 TLS 后做压缩、缓存、WAF                             |

### 2.3 先分清：SNI 前置 vs 正向代理

|                       | SNI 前置（本方案）                | 系统 HTTP 代理（CONNECT）                                   |
| --------------------- | --------------------------------- | ----------------------------------------------------------- |
| 客户端行为            | 以为在连 `a.com`，实际连到代理 IP | 显式配置 `proxy:port`，先发 `CONNECT a.com:443`             |
| 代理看到的内容        | `ClientHello` 里的 SNI            | 明文 `CONNECT` 目标，此时**还没有** SNI                     |
| nginx stream 是否适用 | 是                                | **否**，需 Squid / 3proxy / `ngx_http_proxy_connect_module` |

若客户端是通过内网 DNS 或 `hosts` 把域名指向代理，属于前者，按本方案实施；若客户端填系统代理，见 §8.2。

---

## 3. 方案选型

| 方案                    | 适用                                      | 优点                            | 代价                                               |
| ----------------------- | ----------------------------------------- | ------------------------------- | -------------------------------------------------- |
| **A. 静态 map（推荐）** | 域名可提前枚举                            | 无 DNS 查询、无解析环路、可审计 | 新增域名需 reload                                  |
| **B. 动态 SNI 直转**    | 域名不可预知                              | 任意域名自动生效                | 必须配白名单 + 独立 DNS + 内网监听，否则是开放中继 |
| C. HAProxy              | 需要主动健康检查、多 IP 负载均衡、SNI ACL | 能力更强                        | 多一套组件与运维                                   |
| D. sniproxy             | 极简透传                                  | 配置十几行                      | 社区维护弱、可观测性差                             |
| E. 正向代理（Squid 等） | 客户端填系统代理                          | 支持任意域名与 CONNECT          | 语义不同，见 §2.3                                  |

**推荐路线**：域名可枚举 → A；确认不可枚举 → B（且必须完成 §4.6 的安全三件套）。两到三个域名不值得引入 HAProxy；域名多、源站多 IP 且要求健康检查时再换 C。

---

## 4. 推荐方案 A：静态 SNI 白名单

### 4.1 拓扑

```text
                内网 DNS / hosts / 客户端解析
                            │
                a.example.com ──► 代理 IP :443
                b.example.com ──► 代理 IP :443
                (未知域名) ─────► 代理 IP :443 → 黑洞
                            │
                 ┌──────────┴───────────┐
                 │  nginx stream:443    │
                 │  ssl_preread → map   │
                 └──────────┬───────────┘
                            │ 原始 TLS 字节
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
  10.0.0.11:443       10.0.0.12:443       10.0.0.13:443
  a.example.com       b.example.com       *.example.org
  (证书在源站)         (证书在源站)         (证书在源站)
```

### 4.2 完整配置

`stream` 块与 `http` 块同级，写在 `nginx.conf` 顶层或 `conf.d/` 的独立文件（该文件不放在 `http {}` 内）。

```nginx
stream {
    log_format sni '$remote_addr [$time_local] sni=$ssl_preread_server_name '
                   'up=$upstream_addr bytes=$bytes_sent/$bytes_received '
                   'time=$session_time status=$status';
    access_log /var/log/nginx/sni-proxy.log sni;

    # SNI → 源站地址。带 hostnames 时大小写不敏感、支持通配。
    # ".example.com" 同时匹配裸域与所有子域；"*.example.com" 只匹配子域。
    map $ssl_preread_server_name $upstream_addr {
        hostnames;

        a.example.com           10.0.0.11:443;
        www.a.example.com       10.0.0.11:443;
        .domain-b.com           10.0.0.12:443;
        .domain-c.org           10.0.0.13:443;

        default                 127.0.0.1:1;   # 黑洞：连接被立即拒绝
    }

    server {
        listen 443;
        listen [::]:443;
        ssl_preread on;

        proxy_pass $upstream_addr;

        proxy_connect_timeout 5s;
        proxy_timeout 1h;              # 覆盖 WebSocket / SSE 等长连接的空闲期
        proxy_socket_keepalive on;     # nginx ≥ 1.15.6
        proxy_half_close on;           # nginx ≥ 1.21.0，正确处理单向关闭
        preread_timeout 10s;           # 客户端须在此时间内发出 ClientHello
    }
}
```

要点：

- `proxy_pass` 带变量时按 `IP:port` 解析，**不需要 `resolver`**，因为没有域名要解析。
- `default` 必须是合法地址。用 `127.0.0.1:1`（无服务监听）实现“立即断开”，比留空更干净——留空会在日志里刷 `no host in upstream`。
- 未发 SNI 的客户端同样命中 `default`：`$ssl_preread_server_name` 为空。
- `hostnames;` 必不可少，否则 `*.` / `.` 只被当作字面量。
- 通配只做后缀匹配，跨域名的正则、路径级规则在 TCP 层不存在。

### 4.3 验证透传是否真的端到端

对比代理与直连源站拿到的证书指纹，一致即证明代理未参与 TLS。

```bash
# 经代理
openssl s_client -connect PROXY_IP:443 -servername a.example.com -showcerts </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256 -subject -issuer -dates

# 直连源站
openssl s_client -connect 10.0.0.11:443 -servername a.example.com -showcerts </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256 -subject -issuer -dates

# 业务验证（不改 DNS）
curl -v --resolve a.example.com:443:PROXY_IP https://a.example.com/health

# 负向：白名单外域名应被断开
openssl s_client -connect PROXY_IP:443 -servername not-whitelisted.example 2>&1 | tail -3

# 负向：无 SNI 应被断开
openssl s_client -connect PROXY_IP:443 -noservername 2>&1 | tail -3
```

配置检查：`nginx -t`，然后用 `nginx -T | grep -A30 '^stream'` 确认 `map` 命中顺序。

---

## 5. 方案 B：动态域名（域名不可枚举时）

只有在确认无法提前列出域名时才使用。B 方案等于一个“自动跟随 SNI”的 TCP 中继，**不加白名单就是开放中继**。

```nginx
stream {
    # 必须使用能解析到“真实源站”的 DNS，不能用把域名指向本代理的内网 DNS（见 §5.2）
    resolver 10.0.0.53 valid=30s ipv6=off;
    resolver_timeout 3s;

    map $ssl_preread_server_name $target {
        hostnames;
        default                 127.0.0.1:1;                  # 白名单外一律拒连
        .partner-a.com          $ssl_preread_server_name:443; # 命中则回到同名源站
        .partner-b.com          $ssl_preread_server_name:443;
    }

    server {
        listen 10.0.0.10:443;      # 只绑内网网卡，不暴露公网
        ssl_preread on;
        proxy_pass $target;
        proxy_connect_timeout 5s;
        proxy_timeout 1h;
    }
}
```

### 5.1 白名单为何必须写在 `map` 里

`map` 的默认值同时承担“拒绝”职责：未命中时目标变成黑洞地址，连接在 `proxy_connect_timeout` 内被拒。这样既不需要在 `stream` 里写 `if`，也避免“先连上再判断”的时序问题。

### 5.2 DNS 解析环路

如果客户端靠“内网 DNS 把 `a.com` 指向代理 IP”接入，而代理又用同一个内网 DNS 解析 `a.com`，代理会解析到自己 → 自己连自己。规避方式（三选一）：

1. 代理使用独立的上游 DNS（如 `10.0.0.53` 内网权威 / `8.8.8.8`），解析结果是真实源站；
2. 白名单域名在 `map` 里直接写真实 IP（回到方案 A 的做法）；
3. 代理配置 `resolver` 指向外部 DNS，并在防火墙上禁止代理访问自身 443。

上线前务必用 `dig @10.0.0.53 a.partner-a.com` 确认返回的不是代理自身 IP。

### 5.3 负载均衡的限制

`proxy_pass` 使用变量时不能按名称引用 `upstream` 组。因此：

- 同一域名有多个源站 IP 时，nginx 无法在 SNI 维度做轮询/健康检查；
- 需要该能力时改用 HAProxy（§8.1），或把域名交给 DNS 轮询。

---

## 6. 域名接入方式

| 方式                         | 适用               | 注意                                     |
| ---------------------------- | ------------------ | ---------------------------------------- |
| 内网 DNS 把域名解析到代理 IP | 全员/全内网        | 最常见；与方案 B 组合时注意 §5.2 环路    |
| 客户端 `hosts` 写死          | 少量机器、灰度验证 | 三平台均支持，适合上线前验证             |
| 客户端显式设置代理           | 需要按客户端区分   | 属于 CONNECT 语义，nginx 不适用（§2.3）  |
| 分流网关 / 透明重定向        | 网络层统一管控     | 需要策略路由或 iptables 配合，客户端无感 |

无论哪种方式，客户端都**必须发出该域名的 SNI**；否则无法分流，只能落到 `default`。

---

## 7. 安全与可观测性

### 7.1 安全三件套

1. **白名单**：静态 `map` 本身即白名单；动态方案必须保留 `default → 黑洞`。
2. **收口监听**：`listen` 绑定内网/专线网卡，公网不可达；或在入口防火墙只放行已知客户端网段。
3. **审计**：记录 `$ssl_preread_server_name`、来源 IP、字节数、会话时长；对未知 SNI 计数并告警。

### 7.2 日志与告警

```text
# 建议关注
sni=<未知域名>            命中 default，检查是否漏配或有人在试探
up=127.0.0.1:1            被拒绝的连接
status=502/504            源站不可达或超时
bytes=0/0 time=0          握手前后立即断开（客户端探测/网络问题）
```

按 SNI 聚合 `$bytes_sent` 可得到各第三方站点的流量占比；`$session_time` 可发现长连接异常。

---

## 8. 备选方案

### 8.1 HAProxy（需要 ACL、主动健康检查、多 IP）

```haproxy
global
    log stdout format raw local0

defaults
    mode tcp
    timeout connect 5s
    timeout client  1h
    timeout server  1h

frontend sni_in
    bind *:443
    tcp-request inspect-delay 5s
    tcp-request content accept if { req_ssl_hello_type 1 }
    use_backend be_a if { req_ssl_sni -i api.partner-a.com }
    use_backend be_b if { req_ssl_sni -i -m end .partner-b.com }
    default_backend be_blackhole

backend be_a
    server a1 10.0.0.11:443 check
    server a2 10.0.0.21:443 check

backend be_b
    server b1 10.0.0.12:443 check

backend be_blackhole
    # 无 server：立即断开
```

相比 nginx：支持主动健康检查、按 SNI 的 ACL、动态多后端；代价是新增组件。

### 8.2 客户端填系统代理（CONNECT）

nginx 开源版不支持 CONNECT，选：

- **Squid**（`http_port 3128`，可配 ACL/缓存策略）；
- **3proxy / tinyproxy**（极简）；
- **nginx + `ngx_http_proxy_connect_module`**（第三方补丁，需自行编译）。

注意这条路代理能看到 `CONNECT host:port` 明文，但**看不到 TLS 内部**，与透传方案的安全边界相同。

### 8.3 sniproxy

适合“只想透传、不想要 nginx”的场景，配置约十行；但社区活跃度与可观测性弱于 nginx/HAProxy，不建议作为生产主力。

---

## 9. 风险与已知限制

| 风险                           | 影响                                | 应对                                                           |
| ------------------------------ | ----------------------------------- | -------------------------------------------------------------- |
| 客户端不发 SNI                 | 落到 `default`，连接失败            | 上线前统计 `default` 流量；老客户端单独评估                    |
| ECH（Encrypted ClientHello）   | SNI 被加密，`ssl_preread` 读不到    | 固定域名场景影响有限；公网场景需关注浏览器默认策略变化         |
| HTTP/3（UDP 443）              | 完全绕过 TCP 代理                   | 网络侧禁用 UDP 443，或接受 H3 客户端直连                       |
| 被动健康检查                   | 源站故障切换慢                      | 域名少可接受；要求高时换 HAProxy                               |
| 无法传真实 IP                  | 第三方日志只能看到代理 IP           | 透传固有代价；如为自有服务可协商 PROXY protocol                |
| 空闲超时                       | 长连接被切断                        | `proxy_timeout` 按业务放大到 1h                                |
| 中继滥用                       | 代理成为出口                        | 白名单 + 内网监听 + 防火墙                                     |
| 连接数翻倍                     | 每个会话占用两个 socket             | 调高 `worker_connections`（≥ 8192）与 `worker_rlimit_nofile`   |
| Debian/Ubuntu 未装 stream 模块 | 配置报 `unknown directive "stream"` | 安装 `libnginx-mod-stream`，用 `nginx -V` 确认 `--with-stream` |

---

## 10. 实施步骤

1. **盘点域名**：列出所有要代理的第三方域名与源站 IP，确认客户端是否会发 SNI。
2. **准备 DNS**：确定域名→代理 IP 的解析方式；若用方案 B，先验证 `resolver` 不会解析回代理自身。
3. **写配置**：从 §4.2 复制，替换 `map` 条目；`default` 保持黑洞。
4. **校验**：`nginx -t`，`nginx -T` 检查 `map` 顺序与通配。
5. **灰度**：先用 `hosts` 或单个客户端验证，跑 §4.3 的证书指纹对比与正负向用例。
6. **上线**：切 DNS / 下发配置，观察 `sni-proxy.log` 中 `default` 命中比例。
7. **监控**：按 SNI 建立流量与错误率看板；未知 SNI 归零视为达标。

---

## 11. 结论

- 无证书 + 多 HTTPS 域名 = **SNI 透传**，唯一入口是 `stream { ssl_preread on; }`。
- 域名可枚举时选**静态 map 白名单**：无 DNS 依赖、无环路、可审计，是本场景的默认答案。
- 域名不可预知时才用动态 SNI 直转，并且**白名单、内网监听、独立 DNS** 缺一不可。
- 一旦出现“主动健康检查、多源站负载均衡、复杂 ACL”的需求，直接换 HAProxy，不要在 nginx 配置里堆补丁。
