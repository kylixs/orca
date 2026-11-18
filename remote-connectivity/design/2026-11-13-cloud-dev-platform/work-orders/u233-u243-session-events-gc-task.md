# 任务书：D20 会话事件 + D18 sweep（`AUTH-SESSION-EXPIRE` / `AUTH-TOKEN-GC`）

- 依据：`work-orders/decisions-log-20261118.md` §1（D18、D20）；台账 U233、U243、U230①
- 地图编号：`AUTH-SESSION-EXPIRE`、`AUTH-TOKEN-GC`
- 原则：简单优先——不新增事件体系、不做退役 token FIFO、不做新端点、不做持久化
- 前置：全仓 e2e 全景已结束（写入解冻）

## 切片 1：D20 事件词汇（≤20 分钟）

1. `session.expired`：refresh 过期首次撤销时，`revokeSessionOnce` 返回 true 的分支写 1 条 best-effort 审计：
   - `result=success`、`actor=username`、`targetType=session`、`targetId=session.id`
   - metadata `{ reason: 'EXPIRED', source: 'cookie' | 'body' | 'sweep', expiredAt }`
2. `session.revoked`：替换禁用用户刷新撤销现有的 `logout` + `denied` 两条语义倒置事件；metadata `{ reason: 'USER_DISABLED', source }`。
3. 不改 401 状态码与清 Cookie 行为；其他路径不得改用 `session.revoked`。
4. 测试（`apps/api/test` 或 e2e）：过期只写 1 条且 reason/source 正确；并发刷新仍只 1 条（幂等门）；禁用用户刷新→1 条 `session.revoked` 且无 `logout denied`。
5. 变异点：去掉 `revokeSessionOnce` 返回值判断→重复事件用例红；把 `session.revoked` 改回 `logout`→禁用用例红。

## 切片 2：D18 sweep + 快照剥离（≤20 分钟）

1. 新增 `cloud-platform/apps/api/src/session-sweep.ts`：
   - 配置 `ORCA_CLOUD_SESSION_SWEEP_MS`，默认 60000，`0` 关闭；retention 固定 60000（≥ grace 上限）
   - 删除：过期 `accessTokens`；session 不存在/已撤销的 `accessTokens`；已撤销/过期 session 在 retention 后的 session 与其 `refreshTokens`；孤儿 `refreshTokens`
   - 过期未撤销 session：先 `revokeSessionOnce` 并写 `session.expired(source='sweep')`，下一轮才删
   - `revocations` 永不删除
   - 定时器接线到 server 启动与 close；关闭后无残留 interval
2. 快照剥离 `snapshot-serialize.ts`：`accessTokens` 与 `webHandoffs` 写空数组（保持 schema）；`sessions.currentRefreshToken` 继续剥离。
3. 测试：retention 前后、live session 不删、事件恰 1 条、撤销后旧 token 401、孤儿 refresh 删除、`revocations` 字节不变、close 无残留、快照文本不含 token/handoff 明文。
4. 变异点：删 `revokedAt` 判断→live 被删红；先删后判→事件 0 条红；快照仍序列化 accessTokens→明文断言红。

## 验收与提交

- `pnpm tc:apps`（或对应类型门禁）+ 相关套件全绿；真实数据：预置过期/撤销/在线三类 session 与孤儿 token，断言删除集合与保留集合精确匹配
- 格式影响必须报告（§2-153）；提交分 3 个：事件、sweep、台账；均 `--no-verify` + pathspec
- 台账回写 U243/U230/U233，地图 `AUTH-SESSION-EXPIRE`/`AUTH-TOKEN-GC` 转🟢
