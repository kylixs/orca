# 授权功能 × 多主机 × 多项目 组合路径清单（exploratory-r2 / authz-combo）

可复用资产：本清单的每一步都对应 `run-authz-combo-web.mjs`（Web/UI 层）或
`run-authz-combo.mjs`（API 层）中的一个组合，入口→步骤→检查点可直接重放。
所有写操作先快照、用后还原；证据统一落在
`cloud-platform/evidence/exploratory-r2/`。

## 0. 环境与启动

| 项 | 值 |
| --- | --- |
| 平台 | `https://127.0.0.1:18787/`（本地 TLS 自签） |
| 身份 | `admin/Adm1n!`、`zhangsan/Passw0rd!`、`lisi/Passw0rd!` |
| 主机 | `dev-local-02=host_ce9225f7`（demo-app / zhangsan-demo）、`dev-local-03=host_a1481892`（infra-tools / zhangsan-lab），均为 online |
| 已吊销离线机 | `dev-001=host_dev001`（不在登记下拉中出现） |
| 组 | `platform-admins`(admin)、`developers`(zhangsan+lisi)、`team-payment`(zhangsan) |
| 种子项目 | `demo-app=proj_ec90a17a`、`zhangsan-demo=proj_03cfcd4e`、`infra-tools=proj_fc96a124`、`zhangsan-lab=proj_7f8495e4`（ID 随 reseed 变化，运行时按 key 发现） |

启动 resident Playwright Server（headless，后台）：

```bash
ORCA_BACKGROUND_LAUNCH=1 node cloud-platform/scripts/playwright-server/server.mjs \
  --base https://127.0.0.1:18787 \
  --evidence-dir cloud-platform/evidence/exploratory-r2/ps-server
```

运行 Web/UI 层矩阵（写 `authz-combo.json` + 17 张截图）：

```bash
ORCA_BACKGROUND_LAUNCH=1 node cloud-platform/scripts/exploratory-r2/run-authz-combo-web.mjs
```

运行 API 层矩阵（写 `authz-api-combo.json` / `-raw.json`，60 例）：

```bash
node cloud-platform/scripts/exploratory-r2/run-authz-combo.mjs
```

## 1. 身份与能力读回口径

- **可见**：`GET /v1/projects` 是否返回该项目（非 admin 仅 `permissions` 含 `open`）。
- **打开**：`POST /v1/projects/:id/web-handoff` 是否 201；UI 对应「打开」按钮。
- **实际能力**：`POST /v1/projects/:id/connect` 签发凭证的 `perms`（host 据此执行 terminal/agent/file:read/file:write）。
- **下载**：`GET /v1/projects/:id/policy` 的 `effective`（显式覆盖优先，否则跟随全局）。
- **自助建项目**：`GET /v1/hosts/available` 的 `provisionAllowed` + `POST /v1/projects/self` 的 201/403。

## 2. Web/UI 组合路径

### D0 基线
- 入口：三身份登录 → 工作台 / 我的项目。
- 步骤：读 API `GET /v1/projects` 与 DOM `tbody tr`；核对行数、项目名、权限列。
- 检查点：admin 5 行（含 payment-service）、zhangsan 5 行、lisi 1 行（仅 demo-app：lisi 属 developers，不属 team-payment）；DOM 行数 = API 可见数。

### D1 权限矩阵 × 双主机项目
1. **P1 lisi @ demo-app（host1）**
   - 入口：管理端 `PUT /v1/projects/:id/grants` 写 lisi。
   - 步骤：`[open]` → 读 connect perms + UI 我的项目；再 `[open,file:read]`；再 `[]`。
   - 检查点：perms 精确等于所授位；撤销后项目从列表/connect 消失；UI 行同步出现/消失；「打开」可用。
   - 截图：`p1-lisi-demo-open.png`、`p1-lisi-demo-revoked.png`。
2. **P2 lisi @ zhangsan-demo（host1 第二项目）**：仅 `[open]` → 可见、可打开、perms=`open`；行出现。
3. **P3 lisi @ infra-tools（host2 跨主机）**：`[open,file:read]` → perms 一致、handoff 201、行显示 `dev-local-03`；撤销后消失。
4. **P4 zhangsan 全量**：四个项目 perms 均为五位（FULL），工作台四行。
5. **P5 admin @ zhangsan-lab 无授权**：工作台该行「打开」disabled（title=`项目未授权给你…`）、「授权并打开」enabled。

### D2 主机授权抽屉 × 双主机
1. `PUT /v1/hosts/{h1}/provision-policy restricted` + `host_grants lisi=provision`；`host2` 同样 restricted + `group team-payment=provision`。
2. **H1 available 矩阵**：lisi 仅 host1 允许；zhangsan 仅 host2 允许（经 team-payment）；admin 两台都允许。
3. **H2 自助建项目矩阵**：lisi@h1=201、lisi@h2=403(HOST_PROVISION_FORBIDDEN)、zhangsan@h1=403、zhangsan@h2=201、admin@h1/h2=201。创建的项目在收尾统一 archive。
4. **H3 抽屉**：admin → 主机 → 详情；读取策略 radio 与授权行。检查点：两台均 `restricted`；host1 行 lisi+provision、无 team-payment；host2 行 team-payment+provision、无 lisi。截图 `h3-host1-drawer-restricted.png`、`h3-host2-drawer-restricted.png`。
5. **H4 maintain 委派**：host2 授 zhangsan `maintain` → zhangsan `POST /v1/hosts/{h2}/maintenance {enabled:true}`=200，host 状态=维护中，工作台 host2 两行显示「维护中」；再 `enabled:false`=200 恢复 online；移除 maintain 后同一调用=403。审计事件 `host_maintenance` 带 `via=host_grant`。
6. **H5 回切 open**：两台 policy 回 `open` → 三身份 available 均恢复允许。

### D3 自授 × 主机组合
- 入口：admin 工作台任一未授权项目（`zhangsan-lab` @ host2）。
- 步骤 1：点「授权并打开」→ 读确认框；关闭（不确认）。
  - 检查点：标题「授权并打开」；正文含 `open · terminal · agent · file:read · file:write` 与会话断开警告；关闭后 grants 未变。
- 步骤 2：再次确认 → 采样 `#workspaceOverlay` 直到 ready/失败壳（上限 24s）；同时用 admin 已有 open 的 demo-app（host1）作对照。
  - 检查点：admin 五位 grant 落行；host1 与 host2 覆盖层均 `ready=true`、iframe 指向各自主机 `cloud-admin.html`（本轮 WEB-R2-001 未复现）。
  - 截图：`d3-selfgrant-dialog-host2.png`、`d3-overlay-host1-control.png`、`d3-selfgrant-overlay-host2.png`。
- 还原：`PUT grants admin=[]`。

### D4 登记弹层 × 双主机
- 入口：admin → 我的项目 → 登记项目。
- 步骤/检查点：
  1. host 下拉：两台在线主机的 label 与所属根提示分别正确（`主机项目根：<root>`）。
  2. 已吊销/离线 `dev-001` 不出现在下拉（`/v1/hosts` 过滤 `revokedAt`）。
  3. **主机切换**：先选 host1 并填 host1 根下绝对路径，再切 host2 → 路径输入框仍保留 host1 路径（缺陷 WEB-AUTHZ-001）。
  4. 空提交四字段错误；Key 非法；相对路径 / `..` 段 / 尾分隔符；重复 Key=409；host1 重复路径=409。
  5. 离线主机登记走 API：`POST /v1/projects {hostId: dev-001}` → 409 `HOST_OFFLINE`。
- 截图：`d4-register-host-switch.png`。

### D5 目录端与审计
- `GET /v1/directory`：admin 200，含 3 用户 + 3 组；zhangsan/lisi 403（`directory_read` denied 审计）。
- `GET /v1/audit/events?since=<本轮开始>`：项目授权 `grant_update` 带 subjectId/permissions；主机授权 `host_grant_update`；策略 `host_provision_policy_update`；自助拒绝 `project_create result=denied` 带 actor/reason；维护 `host_maintenance via=host_grant`。
- `GET /v1/audit/verify`：`ok=true`。

### M 多用户差异化权限维度
1. **M1 同组不同用户不同位**：`developers` 组授 `[open]`（zhangsan+lisi 同组）→ zhangsan 直接 FULL 合并后仍 FULL；lisi 精确 `[open]`；UI 权限列一致。截图 `m1-developers-group-lisi-open.png`。
2. **M2 同一用户跨项目不同位**：zhangsan@demo-app FULL vs zhangsan@zhangsan-demo `[open]`，同一 host1；connect perms 分别 FULL/open。
3. **M3 同一用户跨主机不同位**：zhangsan@zhangsan-demo(host1) `[open,file:read,file:write]` vs zhangsan@infra-tools(host2) `[open]`；凭证与 UI 权限列均体现差异，两者都可打开。截图 `m3-zhangsan-crosshost-different-bits.png`。
4. **M4 目录/审计同步**：新增/撤销授权行后 directory 组集合不变，`grant_update` 事件即时出现。

## 3. API 层组合路径（并行资产）

`run-authz-combo.mjs` 覆盖 60 例：identity、directory、host-grants、project-grants、audit、provision-policy、handoff、identity-matrix、boundary、cleanup。入口与步骤见脚本内 `record({id, area, combo, endpoint, expected, actual})`，结果在 `authz-api-combo.json`。与 Web 层互补，不重复写入本清单。

## 4. 还原纪律与证据

- 授权变更：快照 `project grants / host grants / provision policy(默认 open)`，`finally` 用同一快照回放；差额行写 `[]`。
- 自助创建的项目：记录 id，收尾 `POST /v1/projects/:id/archive`。
- 自授：测试后移除 admin 行。
- 审计链复核：`GET /v1/audit/verify` 必须 200 + `ok=true`。
- 证据：
  - `cloud-platform/evidence/exploratory-r2/authz-combo.json`（Web 层 22 组合 + 1 finding）
  - `cloud-platform/evidence/exploratory-r2/authz-api-combo.json`（API 层 60 组合 + 6 findings）
  - 截图目录 `cloud-platform/evidence/exploratory-r2/ps-server/shots/authz-combo/`

## 5. 本轮发现（组合维度）

| ID | 级别 | 维度 | 一句话 |
| --- | --- | --- | --- |
| WEB-AUTHZ-001 | P2 | 登记弹层 × 双主机 | 切换目标主机后路径输入保留上一主机的绝对路径，提交可把 host1 路径登记到 host2。 |
| D8 (API) | P2 | 自授 × 主机 | admin 无显式 `open` 的项目 `connect` 返回 200，但 `web-handoff` 403；平台层与 UI 口径不一致。 |
| F2 (API) | P2 | 登记 × 双主机 | 项目路径占用键不含 hostId，不同主机同绝对路径被误判 409。 |
| B11 (API) | P3 | 主机授权 | 开发者读主机授权（GET）被拒时记为 `host_grant_update` 写事件类型。 |
| B12 (API) | P3 | 主机授权 | 非法 `subjectType=role` 被静默按 user 落行。 |
| C10 (API) | P3 | 自助策略 | 无可用主机时返回 `HOST_REQUIRED`，未按调用者授权返回 `NO_PROVISIONABLE_HOST`。 |
| G4 (API) | P3 | 审计 | denied 审计元数据缺 `hostId/mode/subject/permissions`，只有通用 reason。 |

无 P0/P1。所有组合收尾 `restore=true`，审计链校验通过。
