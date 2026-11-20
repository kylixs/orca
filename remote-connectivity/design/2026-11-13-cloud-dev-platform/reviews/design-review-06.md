# 设计评审 06（终审第 6 轮）

> 日期：2026-11-13
> 评审基线：`20eb6809520`（评审期间仓库前进 1 个提交，结论已对新提交重跑）
> 评审结论：**REJECTED**（0 BLOCKER；3 个新 MAJOR：N1 策略值 fail-open、N2 撤销不关闭已建连接、N3 控制面请求不可中止）
> 修复后状态：3 个 MAJOR + 2 个 MINOR 已闭环，并补了能在修复前失败的回归用例；其余 MINOR 记录为遗留

## 1. 本轮新 MAJOR 与处置

| 编号 | 级别                     | 问题                                                                                          | 处置                                                                                                                                        | 修复前实测                                         | 修复后实测                                                                   |
| ---- | ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| N1   | MAJOR（安全）            | `projectOverrides` 只校验是对象，不校验取值；`123`/`"Deny"` 被当作「非 deny」放行导出         | `parsePolicy()` 逐项要求 `'deny' \| 'allow'`，任一非法整份丢弃、保留上一份策略                                                              | E8a：`PERMISSION_MISSING`（策略被静默忽略）        | E8a：`EXPORT_DENIED`                                                         |
| N2   | MAJOR（AC-25/AC-14）     | 撤销只在升级期检查一次，已建立连接永不关闭                                                    | `PolicyGateway.revocationReason()` 复用同一撤销快照；Runtime 每秒对活动连接复查，命中 `close(4403, reason)`，1 秒未完成握手则 `terminate()` | 吊销后 10 秒 socket 仍 OPEN                        | 4.2 秒内收到 close code **4403**，reason `device_revoked`，后续 RPC 不再成功 |
| N3   | MAJOR（可用性，M2 残留） | `Promise.race` 超时只拒绝外层 Promise，底层 `fetch`/`node:https` 请求不中止；中继连单飞都没有 | `mtlsFetch` 支持 `init.signal`（TLS 分支 `req.destroy()`，HTTP 分支透传 fetch）；Runtime/中继统一用 `AbortSignal.timeout()`；中继加单飞     | Runtime 3.5 秒后 **active=9**（每秒 +3，永不回收） | active ≤ 4；中继同样有界                                                     |

## 2. MINOR 处置

| 编号 | 说明                                                                      | 处置                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N4   | 畸形 200 也算「新鲜」，5 分钟降级永不触发                                 | `policyFreshAt` 仅在**接受了一份合法策略**后更新；陈旧判定每次轮询都执行                                                                                  |
| N5   | E8a 指向已被 E8 停掉的 API，JWKS 先失败，策略路径从未执行，修复前也能通过 | 重写为自包含用例：自建平台 + 真实 JWKS + 真实会话 + `files.download` 断言；已验证修复前变红                                                               |
| N6   | 公网监听同样暴露 `/v1/internal/policy                                     | revocations                                                                                                                                               | relay-routes`，默认令牌有效 | 配置 mTLS 内部监听时，公网监听对 `/v1/internal/*` 返回 404（`relay-endpoint` 除外，中继注册早于 mTLS）。未配置 mTLS 的本地开发场景仍由公网监听兼任，已在设计 §12.1 标注 |
| M8   | 平台只认 `ORCA_CLOUD_INTERNAL_TOKEN`                                      | 同时接受 `INTERNAL_TOKEN`（优先级：config → INTERNAL_TOKEN → ORCA_CLOUD_INTERNAL_TOKEN → 测试默认值）                                                     |
| N7   | 文档与实现不一致（GET/POST、刷新周期、错误码表）                          | 设计 §12.1 改为 GET 并补 policy/revocations/relay-endpoint；配置表 `routeRefreshSeconds` 60→2；§14.5 登记完整 `x-orca-reject` 词表；§7.4 补主机侧实现说明 |
| N8   | 撤销集合只增不减；`usedJtis` 死代码                                       | `appendRevocation()` 按 `targetType+targetId` 去重并刷新时间；删除平台侧未使用的 `usedJtis`                                                               |

## 3. 修复前失败证据（N5 教训）

修复提交前用 `git stash` 临时回退 5 个源文件，对同一批用例实跑：

| 用例                   | 修复前                                   | 修复后       |
| ---------------------- | ---------------------------------------- | ------------ |
| E8a 畸形策略值         | ✖ `PERMISSION_MISSING` ≠ `EXPORT_DENIED` | ✔            |
| M11 设备吊销关闭会话   | ✖ 10 秒内未收到关闭                      | ✔ 4403       |
| M12 Runtime 挂起控制面 | ✖ `active=9 total=9`                     | ✔ active ≤ 4 |
| M12 中继启动           | ✖ `HUNG >3s: never listened`             | ✔ 有界启动   |

## 4. 全量测试

```
node --test test/contract.test.ts                       11 pass
node --test test/e2e/platform.e2e.test.ts               16 pass（E8a 重写）
node --test test/e2e/admin-gating.e2e.test.ts           13 pass
node --test test/e2e/mtls-control-channel.e2e.test.ts    8 pass
node --test test/e2e/relay-hardening.e2e.test.ts         8 pass
node --test test/e2e/revocation.e2e.test.ts              1 pass（新增）
node --test test/e2e/control-plane-resilience.e2e.test.ts 3 pass（新增）
合计 60 pass / 0 fail
```

## 5. 遗留（如实登记，未声称完成）

| 编号                       | 说明                                                                          | 归属                    |
| -------------------------- | ----------------------------------------------------------------------------- | ----------------------- |
| M1                         | 设备公钥持有证明（PoP）需真实 Orca `e2ee_hello`；替身只能证明「头与凭证一致」 | T508                    |
| M4                         | `isInsideRoot` 对 Windows 段大小写敏感（fail-closed，误拒而非误放）           | 后续按需放宽            |
| M5                         | 项目根含 `..` 会在登记处扩大作用域，应在 T105 拒绝非规范化路径                | T105                    |
| M6                         | 写路径参数名与真实 Orca `relativePath` 契约不符                               | T303                    |
| 真实 Runtime               | `worktree.createManaged`、E2EE 握手均只在替身上验证                           | 需可构建的 `orca serve` |
| 桌面补丁层                 | `src/main/cloud-platform/` 未落地                                             | T201–T211               |
| `jwks_stale` / 分支名 `..` | 代码路径存在，无用例覆盖                                                      | 下轮补                  |
