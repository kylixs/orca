# 设计评审 04（终审第 4 轮）

> 日期：2026-11-13
> 结论：**REJECTED**（0 BLOCKER；3 个新 MAJOR：C1 设备绑定可绕过、C2 Windows 路径、C3 停机后 Runtime 崩溃）

## 第 3 轮遗留复核

7 项 CLOSED（符号链接逃逸、方法映射、tasks、browser 权限、外网 allowlist、AC 话术、图表），1 项 PARTIAL（设备绑定仅在携带头时校验）。

## 新发现与处理

| 编号 | 级别 | 问题 | 处理 | 证据 |
|---|---|---|---|---|
| C1 | MAJOR（安全） | 设备公钥校验写成「头存在才校验」，攻击者省略头即可用复制凭证升级 | 改为 fail-closed：头缺失直接拒绝 | E7b2 → 401 `device_pubkey_missing` |
| C2 | MAJOR（跨平台） | `startsWith(root + sep)` 在 Windows 恒失败；`path.relative` 跨盘返回绝对路径，判定函数会返回 true | `isInsideRoot` 改为分段比较 + 盘符一致性；拒绝相对路径入口 | 单元「Windows 盘符、跨盘与分隔符」 |
| C3 | MAJOR（可用性） | 平台停机时 `refreshPolicy` 未捕获拒绝，Runtime 1 秒内崩溃，E8 因检查在首个轮询前而误判通过 | 轮询吞异常并保留上次策略，超 5 分钟降级为全禁；E8 改为停机 3.5 秒后断言 Runtime 存活 + 会话仍可读写 | E8 `runtimeAlive: true`，停机后 `sessions.whoami` 与 `files.read` 均成功 |
| C4 | MINOR（安全） | 先 `mkdir` 后校验，越界路径会在根外建目录；check-then-write 竞态 | 改为校验 → 创建 → 再校验 | `policy-gateway.ts` executeWrite |
| C5 | MINOR | `worktree.createManaged` 直接 `mkdirSync`，未走容器化校验；分支名 `..` 未被清洗 | 改用 `assertInsideRoot`，拒绝点段分支 | E7d |
| C6 | MINOR | `sessions.` 空前缀会让未来新增方法自动放行 | 只登记 `sessions.whoami`、`sessions.list` | 单元「前缀白名单只覆盖已登记自省方法」 |
| C7 | MINOR | `requiresWritePath` 漏 `browser.savePage`；多路径参数方法会漏检 | 补 `browser.savePage` 与 `MULTI_PATH_WRITE_PARAMS` 检查 | 单元 + `authorize` |
| C8 | MINOR | `revokedJtis` 无 TTL；用户撤销无生产者 | 加 10 分钟 TTL；用户撤销生产者列入 T301 待办 | `policy-gateway.ts` |
| C10 | MINOR | 错误表缺 426；AC-30 与实现话术不一致；客户端缺 `tlsFingerprint` | 补 426、统一 AC-30、客户端类型补字段 | design §6.5、requirements AC-30 |
| C11 | MINOR | 内部令牌硬编码默认值 | 支持 `ORCA_CLOUD_INTERNAL_TOKEN` 注入，保留测试默认值 | `server.ts` |

## 本轮测试

```
node --test test/contract.test.ts              10 pass / 0 fail
node --test test/e2e/platform.e2e.test.ts      15 pass / 0 fail
node --test test/e2e/admin-gating.e2e.test.ts  13 pass / 0 fail
合计 38 pass / 0 fail
```

## 遗留（明确不在一期实现，已在文档登记）

- 中继路由同步为明文 HTTP + 内部令牌，生产需 mTLS 8443（设计 §5.1 已要求，T212 待实现）。
- 策略 / JWKS 的 5 分钟缓存 TTL 已在 Runtime 实现为「超时降级 deny」，但未做主动预取刷新。
- 用户级 / jti 级撤销缺少平台侧生产者接口（当前仅项目级）。
