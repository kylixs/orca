# 设计评审 05（主动攻击复核）

> 日期：2026-11-13
> 结论：**REJECTED**（0 BLOCKER；1 个未闭环 MAJOR：C-01 畸形策略导致 Runtime 退出）

## 复核结果

| 项 | 结论 |
|---|---|
| C1 设备绑定 fail-closed | CLOSED（缺头/空串/不匹配全部 401） |
| C2 Windows 路径 | CLOSED（分段比较 + 盘符 + 拒绝相对路径） |
| C3 停机存活 | PARTIAL → MAJOR（见 C-01） |
| C4 先校验后创建 | CLOSED |
| C5 createManaged 容器化 | CLOSED（B2 全部变体未逃逸） |
| C6 自省前缀 | CLOSED |
| C7 写路径覆盖 | PARTIAL（与真实 Orca RPC 参数名不符，见 M6） |
| C8 撤销 TTL / 生产者 | PARTIAL（用户/jti/设备撤销生产者缺失，见 M7） |
| C10 错误码与话术 | CLOSED |
| C11 内部令牌 | PARTIAL（环境变量名分裂，见 M8） |

## 攻击测试实测

| 攻击 | 结果 |
|---|---|
| 设备头缺失 / 空串 / 他人公钥 | 全部 401 |
| 复制凭证 + 从 JWT 读 `devicePubKey` 回放 | **101 放行** — 替身无 `e2ee_hello` 持有证明（M1） |
| 符号链接写逃逸、绝对路径写、`..` / `%2e%2e` / 全角点分支 | 全部拒绝或落根内，外部无文件 |
| 撤销同毫秒 / +1ms / -1ms | 前两者拒绝，后者允许（正确） |
| 停机 5 秒 | 进程存活、会话可读写 |
| 黑洞平台 | 存活但悬挂连接堆积（M2，已修） |
| 畸形 200 策略 | **进程退出（exit 1）** |

## 本轮修复

| 编号 | 级别 | 处理 | 验证 |
|---|---|---|---|
| C-01 | MAJOR | `/v1/internal/policy` 响应做形状校验（缺字段则保留上一份）；`authorize` 移入 `try`；`authorize` 内部对 `policy` 做空值防御 | 新增 E8a：伪造控制面返回 `200 {}`，Runtime 存活，`exitCode`/`signalCode` 均为 null |
| M2 | MINOR | 控制面请求 3 秒超时 + 单飞（in-flight 去重） | 黑洞下不再堆积 |
| M3 | MINOR | `createManaged` 幂等键按 `project:device:key` 命名空间 | E7d 仍通过 |
| M7 | MINOR | 设备吊销写入 `store.revocations`（`targetType:'device'`），经心跳与内部接口下发；Runtime 消费 `device_revoked` | 代码路径 |
| M8 | MINOR | Runtime / Relay 同时接受 `INTERNAL_TOKEN` 与 `ORCA_CLOUD_INTERNAL_TOKEN` | M9 用例通过 |
| M9 | MINOR | JWKS 加 5 分钟 TTL，超期返回 `jwks_stale` 拒绝新连接 | 代码路径 |
| M10 | MINOR | 分支名含 `..` 直接 `BAD_REQUEST`，不再静默改写 | E7d |
| M11 | MINOR | E8 同时断言 `signalCode === null` | E8 通过 |

## 明确未修（记录而非隐藏）

| 编号 | 说明 | 归属 |
|---|---|---|
| M1 | 设备公钥明文在凭证载荷，替身无 `e2ee_hello` 持有证明；真实 Orca 的 X25519 握手可提供 PoP | T508 真实 Runtime 移植用例 |
| M4 | `isInsideRoot` 对 Windows 段大小写敏感（fail-closed 假阴性） | 后续按需放宽 |
| M5 | 根含 `..` 会扩大作用域；应在项目登记处拒绝非规范化路径 | T105 |
| M6 | 参数名与真实 Orca `relativePath` 契约不符；接入 T303 时必须补「选择器 → 路径 → workspaceRoot」断言 | T303 |
| 中继 SNI 证书固定 | 当前中继只按路由表转发，未校验 SNI 白名单与主机证书 | T213 |

## 测试

```
node --test test/contract.test.ts              11 pass / 0 fail
node --test test/e2e/platform.e2e.test.ts      16 pass / 0 fail
node --test test/e2e/admin-gating.e2e.test.ts  13 pass / 0 fail
node --test test/e2e/mtls-control-channel.e2e.test.ts  8 pass / 0 fail
合计 48 pass / 0 fail
```
