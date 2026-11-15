# 授权 API × 多主机 × 多项目组合 — 可重放路径清单 (exploratory-r2)

授权面的组合探索：主机授权 / 自助策略 / 项目授权 / 目录 / handoff / 审计，跨
`dev-local-02`、`dev-local-03` 与三种身份。脚本逐条执行下表，结果写入：

- `cloud-platform/evidence/exploratory-r2/authz-api-combo.json` — findings + 全部用例 + 能力探针摘要
- `cloud-platform/evidence/exploratory-r2/authz-api-combo-raw.json` — 每个请求/响应摘要
- `cloud-platform/evidence/exploratory-r2/authz-api-combo-capability.json` — 真实桌面端按票据执行文件/终端的实测

## 环境与重放

```bash
cd /Users/gongdewei/work/projects/orca

# 60 个组合用例（约 40s；真实平台 API，不启动桌面）
ORCA_LOCAL_ENV_ROOT=~/orca-local-env \
  node cloud-platform/scripts/exploratory-r2/run-authz-combo.mjs

# 能力终证：隐藏启动两个真实桌面会话（lisi 只读 / zhangsan 全位），
# 按票据实际调用 files.read / files.write / terminal.create
ORCA_BACKGROUND_LAUNCH=1 ORCA_LOCAL_ENV_ROOT=~/orca-local-env \
  node cloud-platform/scripts/exploratory-r2/probe-authz-capability.mjs
```

- 平台：`https://127.0.0.1:18787`（CA=`~/orca-local-env/tls/ca.pem`，脚本自带）
- 身份：`admin/Adm1n!`、`zhangsan/Passw0rd!`（组 `developers`、`team-payment`）、
  `lisi/Passw0rd!`（组 `developers`，首次登录落目录）
- 主机：`host_ce9225f7`=dev-local-02、`host_a1481892`=dev-local-03
- 种子项目：demo-app(P_DEMO,h2)、zhangsan-demo(P_ZHAN,h2)、infra-tools(P_INFRA,h3)、
  zhangsan-lab(P_LAB,h3)、payment-service(dev-001,离线)
- 基线授权：demo-app 组 `team-payment` 全位、lisi=`open,file:read`、admin 全位；
  infra-tools 组全位、admin 全位；zhangsan-lab 仅 zhangsan 全位（admin 无 open）

### 可逆纪律（脚本自动执行）

1. 开跑快照两台主机授权行 → 清空做隔离基线 → 收尾按快照逐行还原；
2. 5 个种子项目的授权行快照 → 全部改动后逐行还原并逐字比对（D10）；
3. `provision-policy` 一律恢复 `open`（缺省语义）；
4. 所有探针项目 `archive`；探针宿主不使用；
5. 收尾核对：种子项目仍 `ready`、活动项目数、审计链 `verify` 通过。

### 重要前提

1. **共享实例**：其它操作者可能同时改主机授权/建项目。脚本以开跑快照隔离并在 H1
   记录 `beforeSnapshotRestore`；外部行记为 ENV，不作为缺陷。
2. **open 是显式项目位**：admin 不隐式持有；handoff 明确要求显式 open（种子数据已授
   admin）。D8 发现 connect 与 handoff 在此不一致。
3. **主机位不进凭证**：`provision/maintain/view` 只在平台侧消费（B16 验证）。
4. **组/用户行为并集**：没有 deny 覆盖语义（B15/C8 验证）。
5. **能力探针参数**：宿主 RPC 的 `worktree` 必须是 runtime selector（`path:<worktree>`），
   `files.write` 还需 `expectedExecutionHostId:'local'`；这是探针踩坑，不是产品缺陷。

## 组合用例

| ID | 端点 | 组合 | 结果 | 级 |
|----|------|------|------|----|
| A1 | POST /v1/auth/login | 三身份登录；lisi 首次登录落目录 | pass | - |
| A2 | GET /v1/directory | 目录基线（开发/平台管理/支付组） | pass | - |
| A3 | GET/PUT /v1/hosts/{id}/grants | 双主机授权快照 → 隔离清空 | pass | - |
| A4 | GET /v1/projects/{id}/grants | 5 个种子项目授权快照 | pass | - |
| A5 | GET /v1/audit/verify | 开局链完整性 | pass | - |
| B1 | PUT/GET /v1/hosts/{id}/grants | 同主体仅 h2 直授 provision；h3 不受影响 | pass | - |
| B2 | PUT/GET /v1/hosts/{id}/grants | 同主体跨主机双行独立存在 | pass | - |
| B3 | PUT /v1/hosts/{id}/grants | 空数组删除整行（仅该主机） | pass | - |
| B4 | PUT /v1/hosts/{id}/grants | 部分位全量替换（非合并） | pass | - |
| B5 | PUT /v1/hosts/{id}/grants | 超集往返 provision+view → provision | pass | - |
| B6 | PUT/GET /v1/hosts/{id}/grants | 组行 + 用户行并存 | pass | - |
| B7 | PUT /v1/hosts/{id}/grants | 非法位 `root` → 400，行保留 | pass | - |
| B8 | PUT /v1/hosts/{id}/grants | permissions 非数组 → 400，行保留 | pass | - |
| B9 | PUT /v1/hosts/{id}/grants | 未知用户/组 400 幂等；目录不增长 | pass | - |
| B10 | PUT /v1/hosts/{id}/grants | 开发者写 → 403 + denied 审计 | pass | - |
| B11 | GET /v1/hosts/{id}/grants | 开发者读 → 403，但读请求落成 `host_grant_update` denied | **fail P3** | P3 |
| B12 | PUT /v1/hosts/{id}/grants | `subjectType:"role"` 被当 user 接受并改写行 | **fail P3** | P3 |
| B13 | PUT /v1/hosts/{id}/grants | 空数组删除未知主体 → 先解析 400 | pass | - |
| B14 | PUT /v1/hosts/{id}/grants | 组主体用用户名 → GROUP_NOT_FOUND | pass | - |
| B15 | PUT grants ×2 + available + self | 组 provision + 用户 view → 并集仍可建 | pass | - |
| B16 | PUT grants + POST connect | 主机位不进入票据 perms | pass | - |
| C1 | PUT provision-policy + GET available | 双 restricted：直授/组/admin 的 provisionAllowed | pass | - |
| C2 | POST /v1/projects/self | restricted 无授权 → 403 HOST_PROVISION_FORBIDDEN + 审计 | pass | - |
| C3 | POST /v1/projects/self | 直授成员 restricted 建项目 201；自动 5 位授权 | pass | - |
| C4 | PUT group grant + available + self | 组授权成员 restricted 建项目 201 | pass | - |
| C5 | POST /v1/projects/self | admin 例外在 restricted 仍可建 | pass | - |
| C6 | POST /v1/projects/self | 同主体 h2 允许 / h3 拒绝（跨主机判定） | pass | - |
| C7 | PUT group(h3) + POST self | restricted 下组授权与直授并存 | pass | - |
| C8 | PUT grants + available + self | 删直授后组行仍生效（并集无 deny） | pass | - |
| C9 | PUT grants [] + available + self | 撤净授权后 restricted 立即生效 | pass | - |
| C10 | POST /v1/projects/self | 双 restricted、省略 hostId → HOST_REQUIRED 列出两台不可用主机 | **fail P3** | P3 |
| C11 | PUT policy ∥ POST self | 在途自助创建 × open→restricted 并发 4 轮 | pass | - |
| C12 | PUT provision-policy | 非法 mode 400；开发者 403 | pass | - |
| C13 | PUT policy + GET available | restricted→open 往返恢复 | pass | - |
| D1 | PUT grants + GET project + connect | lisi 跨主机：h2 read / h3 write，票据逐位一致 | pass | - |
| D2 | PUT grants + connect | 逐主机独立演进（h2 加 write/terminal、h3 撤 read） | pass | - |
| D3 | POST web-handoff | lisi 跨主机 admin surface URL 路由 | pass | - |
| D4 | PUT grants ×3 + connect ×2 | 同组不同用户不同位（组+用户并集） | pass | - |
| D5 | PUT group [] + connect ×2 | 撤组行只去掉组来源的位 | pass | - |
| D6 | PUT grants ×2 + connect ×2 | 同用户跨项目跨主机不同位 | pass | - |
| D7 | GET/connect/grants/handoff | 无授权用户不泄露存在性 | pass | - |
| D8 | connect / web-handoff | admin 无 open：handoff 403，但 connect 200（perms=[]） | **fail P2** | P2 |
| D9 | GET grants + GET project + connect | 4 项目 × 3 身份：票据=视图=行并集（12 格） | pass | - |
| D10 | PUT /v1/projects/{id}/grants | 种子项目授权逐行还原并比对 | pass | - |
| E1 | PUT host group + GET directory | 已知组重复授权不新增；未知组 400×2 | pass | - |
| E2 | PUT project group | 未知组 400 幂等、无行落库 | pass | - |
| E3 | GET /v1/directory | 开发者 403 | pass | - |
| E4 | PUT host+project group + directory | 同组多处引用只列一次 | pass | - |
| F1 | POST /v1/projects ×2 | 同 key 跨主机：key 平台唯一 → 409 PROJECT_EXISTS | pass | - |
| F2 | POST /v1/projects ×2 | 同绝对路径跨主机：设计键是 (host_id,path)，实际全局 409 | **fail P2** | P2 |
| F3 | POST /v1/projects | 不同主机不同 path 正常共存 | pass | - |
| F4 | POST web-handoff {surface:admin} | 双主机 URL：host 页、embed=1、project=id、api | pass | - |
| F5 | POST /v1/web/handoff | 兑换 200；重放 410 | pass | - |
| F6 | POST /v1/projects/self ×2 | 同目录名跨主机（不同根）均 201 | pass | - |
| F7 | archive + POST /v1/projects | 归档释放 key 后跨主机复用 | pass | - |
| G1 | GET /v1/audit/events | 4 类事件齐全，授权/策略元数据完整 | pass | - |
| G2 | GET /v1/audit/events?result=denied | restricted 自助拒绝、非 admin 主机授权拒绝 | pass | - |
| G3 | GET /v1/audit/verify | 组合变更后链完整性 | pass | - |
| G4 | GET /v1/audit/events?result=denied | denied 事件缺 design 要求的 hostId/mode/subject 元数据 | **fail P3** | P3 |
| H1 | archive + PUT grants + PUT policy | 探针归档、快照还原、策略恢复、种子完好 | pass | - |

## Findings（6）

| ID | 级 | 一句话 |
|----|----|--------|
| D8 | P2 | admin 无显式 open 的项目：`/connect` 仍 200 并签发 `perms=[]` 票据，而 `/web-handoff` 同谓词 403。 |
| F2 | P2 | 项目路径占用校验不含 hostId（`project-occupancy.ts`），设计键 `(host_id,path)` 的跨主机同路径被 409 PROJECT_PATH_TAKEN 误拒。 |
| B11 | P3 | 非 admin `GET /hosts/{id}/grants` 的 403 被写成 `host_grant_update` denied（读请求落成写事件类型）。 |
| B12 | P3 | `PUT /hosts/{id}/grants` 的 `subjectType:"role"` 被静默按 user 处理并改写授权行（应 400）。 |
| C10 | P3 | 两台主机均 restricted 且调用者无任何 provisionAllowed 时，自助建项目返回 HOST_REQUIRED 并列出两台不可用主机，而非 NO_PROVISIONABLE_HOST。 |
| G4 | P3 | denied 的 `host_grant_update` / `host_provision_policy_update` 只带通用 `{reason,requiredPermission}`，缺设计表的 hostId/mode/subject/permissions（hostId 仅 targetId）。 |

## 能力终证（真实桌面端）

`probe-authz-capability.mjs` 隐藏启动两个会话（无 `show()`/焦点），宿主侧实际执行：

| 身份 | 票据 perms（workspace.info） | files.read | files.write | terminal.create | 期望 |
|------|------------------------------|-----------|-------------|-----------------|------|
| lisi | open,file:read | ok | forbidden `PERMISSION_MISSING file:write` | forbidden `PERMISSION_MISSING terminal` | 一致 |
| zhangsan | open,terminal,agent,file:read,file:write | ok | ok（随后 files.delete 清理） | ok（随后 terminal.close） | 一致 |

结论：票据 perms 与宿主实际执行逐位一致；写文件清理、终端全部关闭。

## 结果快照

- 60 用例 / 54 pass / 6 findings（P0=0、P1=0、P2=2、P3=4）
- 组合覆盖：host-grants 17、provision-policy 13、identity-matrix 6、directory 5、
  boundary 5、audit 5、project-grants 3、handoff 3、cleanup 2、identity 1
- 还原：项目授权、主机授权快照、策略 open、探针归档均为 true；审计链 verify 通过
