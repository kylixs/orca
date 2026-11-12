# 开发进度

> 更新时间：2026-11-13 02:40
> 规则：每轮只推进一个模块；失败必须如实记录。

## 模块状态

| 模块 | 状态 | 证据 | 备注 |
|---|---|---|---|
| M0 契约 | ✅ 完成 | `evidence/e2e-platform/` + 单元 7/7 | 凭证 Ed25519、方法映射、路径边界、审计链 |
| M1 平台 API | ✅ 完成 | E1–E8 | 登录锁定、会话纪元、ACL、凭证、策略、审计、内部接口 |
| M2 中继 | ✅ 完成 | E2、E10 | SNI ClientHello 解析、纯 TCP、黑洞、路由同步 |
| M3 运行时 + 策略网关 | ✅ 完成 | E3–E6 | 升级期验签、方法权限、路径边界、导出拦截 |
| M4 客户端 | ✅ 完成 | E1、E2 | 无凭证预检、直连优先、中继回落 |
| M5 Agent | ✅ 完成 | Web 主机页在线 | 注册、心跳、撤销同步 |
| M6 Web 前端 | ✅ 完成 | `evidence/web-ui/*.png` | 6 个页面 + 403 + 角色门禁 |
| M7 端到端 | ✅ 完成 | `evidence/e2e-platform/*.json` | 10 条用例全通过 |

## 最近一次测试结果

```
node --test test/contract.test.ts            7 pass / 0 fail
node --test test/e2e/platform.e2e.test.ts   10 pass / 0 fail
```

E2E 覆盖：
- E1 登录 → 项目列表 → 直连打开
- E2 直连不可达 → SNI 中继回落
- E3 伪造凭证升级被拒
- E4 方法级权限（无 file:write 被拒）
- E5 导出类方法拒绝
- E6 路径穿越 / 跨工作区写越界
- E7 撤销后旧凭证失效、新登录不可见
- E8 平台停机：已有会话继续，新连接失败
- E9 证据汇总
- E10 中继未知 SNI 黑洞

## 阻塞

无。

## 下一步

1. 设计文档第 2 轮评审问题修复（`worktree.create` 路径契约那条阻断项）。
2. 把真实 Orca Runtime 接入替身接口（需要本地可构建的 `orca serve`）。
3. 客户端补丁层落地到 `src/main/cloud-platform/`（需在 Orca 根工程跑 typecheck/lint）。
