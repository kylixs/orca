# 探索路径 r7 · P2 打磨批真机验证（2026-11-16）

> 目标：部署 ②③⑤④a/b 后，在持久环境（18787）逐条验证用户可见行为与证据留存。
> 前置：`--platform-only` 刷新后核验 served app.js 哈希=源；用户 admin/Adm1n!、zhangsan/Passw0rd!、lisi/Passw0rd!。

## P1 中继刷新失败反馈（U136②）

1. 以 admin 进入 `#/relays`，等表格加载完成，记录行数 N
2. 触发刷新失败：断网或在 devtools 注入 503（或临时停 relay 端口不可达）
3. 断言：`.note.warn` 横幅出现且含原因；表格仍 N 行；无 toast；1.2s 内无第二次自动请求（Network 面板计数）
4. 恢复后点横幅内「重试」→ 表格重载成功、横幅消失
5. 证据：截图（失败态/成功态）+ 请求计数 JSON

## P2 审计页链健康/容量/verify（U136③）

1. admin `#/audit`：确认「链健康与容量（只读）」展开显示 `chain.ok/lastSeq`、容量今日/累计、`persisted`
2. 点「校验审计链」→ 内联显示「校验通过：已校验 N 条，链尾 …」
3. auditor（lisi 若为 auditor，否则临时提权）登录：项目/主机下拉显示「无可见项目（需 open 授权）」/「无可见主机（需主机权限）」；事件列表仍正常渲染
4. 证据：截图 2 张

## P3 主机授权收缩撤凭证（U136⑤）

1. admin 给 zhangsan 主机 dev-local-02 full 授权 → zhangsan 取 accessToken 记录
2. admin 将授权降为 read-only
3. 断言：zhangsan 旧 token 下一次**平台**主机操作请求 **403**（实时位门禁 `HOST_PROVISION_FORBIDDEN`；平台会话按设计保留，401 仅发生在宿主侧旧 ticket，需宿主入口探针）；`host_grant_update` success 事件含 `removedPermissions:['provision']`、`revokedUsers:1`、`accessLevel:'read-only'`，且持久化撤销记录含 `zhangsan/host_grant_changed`
4. 反例：给 lisi 扩容授权 → lisi 会话不被撤销
5. 证据：API 响应 JSON + 审计事件

## P4 下载策略并发冲突（U136④）

1. admin A 读设置页策略（version N）
2. 另一会话 admin B 保存一次（version N+1）
3. A 再保存 → 页面提示「策略已被他人修改」并展示服务端当前值；A 的输入保留；点「刷新后重试」→ 保存成功
4. 断言：B 后写未被 A 覆盖（GET 校验）；`policy_update` 冲突事件含 expectedVersion/resultVersion
5. 证据：截图 + 审计事件

## P5 既有回归抽检（不回归）

- `#/hosts` 吊销/维护按钮仍工作；`#/users` 详情改角色（启用账号）200；`#/audit` 过滤与分页正常
- 证据：各页截图

## 判定

- 每路径 PASS/FAIL；FAIL 记录最小复现与网络/审计证据
- 任一 FAIL → 台账登记再修复；全部 PASS → 更新 PROGRESS 并在最终报告中列为已验
