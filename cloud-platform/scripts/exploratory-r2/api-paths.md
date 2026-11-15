# Cloud Dev Platform — API 探索用例清单 (exploratory-r2)

可重放的平台 API 探索用例。脚本逐条执行下表的“检查点”，结果同时写入：

- `cloud-platform/evidence/exploratory-r2/api.json` — findings（端点/操作/预期/实际/级）
- `cloud-platform/evidence/exploratory-r2/api-raw.json` — 全部用例的请求/响应摘要

## 环境与重放

```bash
cd /Users/gongdewei/work/projects/orca
ORCA_LOCAL_ENV_ROOT=~/orca-local-env \
ORCA_LOCAL_PLATFORM_URL=https://127.0.0.1:18787 \
  node cloud-platform/scripts/exploratory-r2/run-api-exploratory.mjs

# 跳过 58s/62s 两段真实等待（handoff TTL 边界）
ORCA_R2_SKIP_TIMING=1 node cloud-platform/scripts/exploratory-r2/run-api-exploratory.mjs
```

- 平台实例：`https://127.0.0.1:18787`（TLS，CA=`~/orca-local-env/tls/ca.pem`，脚本自带 CA）
- 账号：`admin/Adm1n!`、`zhangsan/Passw0rd!`、`lisi/Passw0rd!`；`INTERNAL_TOKEN=m114-link-token`
- 宿主/项目基线：`dev-local-02`（demo-app、zhangsan-demo）、`dev-local-03`（infra-tools、zhangsan-lab）；全局策略 `allow` + 600 calls/64MiB
- 只读探索 + 可逆变更：探针项目用后归档，探针宿主用后吊销，全局策略恢复原值。归档项目与已吊销宿主作为惰性记录留存（内存 store，平台重启即消失）

### 重要行为前提

1. **handoff 需要显式 `open` 授权，admin 也不例外**（`handleWebHandoff` 用与兑换相同的授权谓词）；种子数据显式授予 admin。回归重放时，临时项目上必须先给 admin 授予 `open` 才能测 handoff 的 201 形态。
2. **项目访问门先于 admin-only 校验**：无 `open` 的开发者访问项目子路由得到 404（不泄露存在性），而不是 403。403 只用于“有 open、但操作需要 admin”的场景。
3. **mTLS 负向在当前实例不可测**：本实例只启用公网 TLS（`PLATFORM_TLS_*`），未配置 `INTERNAL_TLS_KEY/CERT/CA`。因此 `/v1/internal/*` 在公网监听上按令牌校验（本地开发语义）。mTLS 负向需另起一个配置了 `INTERNAL_TLS_*` 的实例重放（公网监听访问内部路径应得 404）。
4. 共享实例可能被其它操作者同时使用（本次运行期间观察到外部 admin 对 `dev-local-02` 切换维护、并发签发 handoff）。脚本在依赖种子主机的阶段前等待其 `online`，但仍可能出现外部级联；此类环境事件单独记为 `ENV-*`。

### 严重度口径

| 级 | 含义 |
|----|------|
| P0 | 未认证绕过、跨租户/越权读取、平台沦陷、审计链破坏 |
| P1 | 已认证输入即可造成平台级可用性/敏感信息影响（如一个坏心跳打挂项目列表） |
| P2 | 契约破坏、静默破坏状态/授权、一次性凭证损失、可分页接口失去边界 |
| P3 | 校验/错误码/可观测性细节，影响面有限 |

---

## A. 认证与会话

| ID | 端点 | 操作 | 边界样本 | 检查点 | 失配级 |
|----|------|------|----------|--------|--------|
| A1 | POST /v1/auth/login | 缺全部字段 | `{}` | 401/423，不得 500 | P3 |
| A2a | POST /v1/auth/login | 真实账号错误密码 | admin? 否：`zhangsan` + 错密码 | 401 INVALID_CREDENTIALS | P3 |
| A2b | POST /v1/auth/login | 失败一次后正确登录 | 正确密码 | 200（计数被清零） | P3 |
| A3 | POST /v1/auth/login | 连续失败锁定 | 不存在账号 ×5，再 ×1 | 前 4×401，第 5/6 次 423 ACCOUNT_LOCKED | P3 |
| A4 | POST /v1/auth/login | 畸形 JSON | `{not-json` | 401/423，不得 500 | P3 |
| A5 | POST /v1/auth/login | Unicode 用户名 | `不存在的用户` | 401/423，不得 500 | P3 |
| A6 | POST /v1/auth/login | 超长用户名 | 5000×`x` | 401/423，不得 500 | P3 |
| A7 | POST /v1/auth/login | 并发登录 | 同一开发者两路并发 | 2×200，token/device 互异 | P2 |
| A8 | POST /v1/auth/login | 携带他人 deviceId | `deviceId=<admin device>` | 忽略外来设备、返回新设备 | P1 |
| A8b | GET /v1/me/devices | 设备归属未被篡改 | admin 会话 | admin 设备仍在 admin 名下 | P1 |
| A9 | POST /v1/auth/login | 携带本人有效 deviceId | 本人设备 id | 复用同一设备 id | P3 |
| A10 | POST /v1/auth/refresh | 正常轮换 | 有效 refreshToken | 200 新 token，新 access 可用 | P3 |
| A11 | POST /v1/auth/refresh | 旧 refresh 重放 | 已轮换的旧 token | 401 SESSION_EXPIRED 且会话被撤销 | P2 |
| A12a | POST /v1/auth/refresh | 缺 refreshToken | `{}` | 401 SESSION_EXPIRED | P3 |
| A12b | POST /v1/auth/refresh | 错误类型 | `refreshToken:12345` | 401 SESSION_EXPIRED | P3 |
| A13 | POST /v1/auth/logout | 登出后凭证失效 | access+refresh | logout 200，me 401，refresh 401 | P3 |
| A13b | POST /v1/auth/logout | 无 token 幂等 | 空 | 200 | P3 |
| A14 | POST /v1/auth/refresh | 并发轮换 | 同一 refreshToken 两路 | 恰好一个 200、一个 401 | P2 |
| A15 | GET /v1/auth/login | 错误方法 | — | 404 | P3 |
| A16 | POST /v1/auth/login | 空串账号密码 | `{"username":"","password":""}` | 401/423，不得 500 | P3 |

## P. 项目 CRUD（admin 路径）

| ID | 端点 | 操作 | 边界样本 | 检查点 | 失配级 |
|----|------|------|----------|--------|--------|
| P1 | POST /v1/projects | 缺 hostId | `{}` 等效 | 400 HOST_NOT_FOUND | P3 |
| P2 | POST /v1/projects | 未知 hostId | `host_missing` | 400 HOST_NOT_FOUND | P3 |
| P3 | POST /v1/projects | 离线主机 | `host_dev001` | 409 HOST_OFFLINE | P3 |
| P4a | POST /v1/projects | 大写 key | `UPPER` | 400 PROJECT_KEY_INVALID | P3 |
| P4b | POST /v1/projects | Unicode key | `项目` | 400 PROJECT_KEY_INVALID | P3 |
| P4c | POST /v1/projects | 穿越片段 key | `../etc` | 400 PROJECT_KEY_INVALID | P3 |
| P4d | POST /v1/projects | 超长 key | 65 字符 | 400 PROJECT_KEY_INVALID | P3 |
| P4e/P4f/P4g/P4h | POST /v1/projects | 空/`.`/`..`/结尾点 key | 四种 | 400 PROJECT_KEY_INVALID | P3 |
| P5 | POST /v1/projects | 超长名称 | 201 字符 | 400 PROJECT_NAME_INVALID | P3 |
| P6 | POST /v1/projects | 相对路径 | `relative/path` | 400 PROJECT_PATH_INVALID | P3 |
| P7 | POST /v1/projects | `..` 段 | `/srv/work/../etc` | 400 PROJECT_PATH_INVALID | P3 |
| P8 | POST /v1/projects | 重复分隔符 | `/srv//work` | 400 PROJECT_PATH_INVALID | P3 |
| P9 | POST /v1/projects | 结尾分隔符 | `/srv/work/` | 400 PROJECT_PATH_INVALID | P3 |
| P10 | POST /v1/projects | 控制字符 | `/srv/work/\u0001x` | 400 PROJECT_PATH_INVALID | P3 |
| P11 | POST /v1/projects | repoUrl 短横线开头 | `-oProxyCommand=x` | 400 REPO_URL_INVALID | P3 |
| P12 | POST /v1/projects | git ext:: 传输 | `ext::sh -c id` | 400 REPO_URL_INVALID | P3 |
| P13 | POST /v1/projects | repoUrl 错误类型 | `{"url":"x"}` | 400 REPO_URL_INVALID | P3 |
| P14 | POST /v1/projects | repoUrl 超长 | 4097 字符 | 400 REPO_URL_INVALID | P3 |
| P15 | POST /v1/projects | 分支短横线开头 | `-main` | 400 BRANCH_INVALID | P3 |
| P16 | POST /v1/projects | 分支含 `..` | `a..b` | 400 BRANCH_INVALID | P3 |
| P17 | POST /v1/projects | 分支超长 | 201 字符 | 400 BRANCH_INVALID | P3 |
| P18 | POST /v1/projects | 合法创建（无 repo） | 唯一 key/path | 201，status=ready，repoUrl="" | P3 |
| P19 | POST /v1/projects | 重复 key | 与 P18 相同 | 409 PROJECT_EXISTS | P3 |
| P20 | POST /v1/projects | 同路径不同 key | — | 409 PROJECT_PATH_TAKEN | P3 |
| P21 | POST /v1/projects | Unicode 名称与路径 | `项目名称-探针` / `/srv/work/工作-*` | 201 | P3 |
| P22 | PUT /v1/projects/:id | 开发者冒充 admin（有 open） | 改 defaultBranch | 403 PERMISSION_DENIED | P2 |
| P23 | PUT /v1/projects/:id | path 不可变 | `{path}` | 400 PROJECT_FIELD_IMMUTABLE | P3 |
| P24 | PUT /v1/projects/:id | hostId 不可变 | `{hostId}` | 400 PROJECT_FIELD_IMMUTABLE | P3 |
| P25 | PUT /v1/projects/:id | 非法 repoUrl | `-x` | 400 REPO_URL_INVALID | P3 |
| P26 | PUT /v1/projects/:id | 非法分支 | `-x` | 400 BRANCH_INVALID | P3 |
| P27 | PUT /v1/projects/:id | 合法分支更新 | `feature/r2-probe` | 200 且值生效 | P3 |
| P28 | PUT /v1/projects/:id | 未知字段/name | `{name,unknownField}` | 200 忽略未知字段 | P3 |
| P29 | POST /v1/projects/:id/archive | 无权限开发者 | zhangsan（非创建者） | 404 PROJECT_NOT_FOUND | P2 |
| P30 | POST /v1/projects/:id/archive | 管理员归档 | — | 200 status=archived | P3 |
| P31 | GET /v1/projects/:id | 归档后读取 | — | 404 PROJECT_NOT_FOUND | P3 |
| P32 | PUT /v1/projects/:id | 归档后更新 | — | 404 PROJECT_NOT_FOUND | P3 |
| P33 | GET /v1/projects/:id/grants | 归档后读授权 | — | 404 PROJECT_NOT_FOUND | P3 |
| P34 | POST /v1/projects/:id/restore | 恢复 | — | 200 status=ready | P3 |
| P35 | POST /v1/projects/:id/archive | 重复归档 | — | 200 status=archived | P3 |
| P36 | POST /v1/projects | 归档释放 key 后复用 | 同 key、新 path | 201 | P3 |
| P37 | POST /v1/projects/:id/restore | 恢复时 key 冲突 | 旧项目 + 占用者 | 409 PROJECT_KEY_TAKEN | P2 |
| P38 | POST /v1/projects/:id/archive | 归档冲突项目 | — | 200 | P3 |
| P39 | POST /v1/projects/:id/restore | 冲突解除后恢复 | — | 200 status=ready | P3 |
| P40 | POST /v1/projects/proj_missing/archive | 不存在项目 | — | 404 PROJECT_NOT_FOUND | P3 |
| P41 | GET /v1/projects/proj_missing | 不存在项目 | — | 404 PROJECT_NOT_FOUND | P3 |
| P42 | GET /v1/projects/:id/open | 未知动作 | `/open` | 404 NOT_FOUND | P3 |
| P43 | GET /v1/projects?includeArchived=1 | admin 可见归档 | — | 含归档行 | P3 |
| P44 | GET /v1/projects?includeArchived=1 | 开发者不可见归档 | — | 不含归档行 | P3 |
| P45 | POST /v1/projects | 非法 downloadPolicy | `banana` | 应 400；实际 201 且静默按 deny | P3 |
| PX1 | GET /v1/projects(:id) | repoUrl 内嵌凭据暴露 | `https://user:S3cret@…` + 仅 open 用户 | 非 admin 不应收到凭据 | P2 |

## S. 自助建项目（developer 路径）

| ID | 端点 | 操作 | 边界样本 | 检查点 | 失配级 |
|----|------|------|----------|--------|--------|
| S1 | POST /v1/projects/self | 显式 path | `path:/etc` | 400 PROJECT_PATH_FORBIDDEN | P3 |
| S2 | POST /v1/projects/self | 空名称 | `name:""` | 400 PROJECT_NAME_INVALID | P3 |
| S3 | POST /v1/projects/self | 名称 201 | 201×`n` | 400 PROJECT_NAME_INVALID | P3 |
| S4 | POST /v1/projects/self | 中文名派生 key 为空 | `name:中文名` | 400 PROJECT_KEY_INVALID | P3 |
| S5 | POST /v1/projects/self | dir=`..` | — | 400 INVALID_DIR | P3 |
| S6 | POST /v1/projects/self | dir 含分隔符 | `a/b` | 400 INVALID_DIR | P3 |
| S7 | POST /v1/projects/self | dir=`.` | — | 400 INVALID_DIR | P3 |
| S8 | POST /v1/projects/self | dir 绝对路径 | `/abs` | 400 INVALID_DIR | P3 |
| S9 | POST /v1/projects/self | 非法 repoUrl | `ext::sh -c id` | 400 REPO_URL_INVALID | P3 |
| S10 | POST /v1/projects/self | 主机无 projectsRoot | `host_dev001` | 409 HOST_NOT_PROVISIONABLE | P3 |
| S11 | POST /v1/projects/self | 未知主机 | `host_missing` | 400 HOST_NOT_FOUND | P3 |
| S12 | POST /v1/projects/self | 多台可建主机未指定 | 省略 hostId | 409 HOST_REQUIRED | P3 |
| S13 | POST /v1/projects/self | 合法创建 | 唯一 name/key/dir | 201 + 自动 open/terminal/agent/file:* | P3 |
| S14 | POST /v1/projects/self | 重复 key | 与 S13 相同 | 409 PROJECT_KEY_TAKEN | P3 |
| S15 | POST /v1/projects | 开发者走 admin 端点 | — | 403 PERMISSION_DENIED | P2 |
| S16 | POST /v1/projects/:id/archive | 创建者归档 | — | 200 status=archived | P2 |
| S17 | POST /v1/projects/:id/restore | 创建者恢复 | — | 200 status=ready | P2 |

## G. 项目授权

| ID | 端点 | 操作 | 边界样本 | 检查点 | 失配级 |
|----|------|------|----------|--------|--------|
| G1 | PUT /v1/projects/:id/grants | 非法权限位 | `root` | 400 GRANT_PERMISSION_INVALID | P3 |
| G2 | PUT /v1/projects/:id/grants | 合法+非法混合 | `["open","root"]` | 400 GRANT_PERMISSION_INVALID | P3 |
| G3 | PUT /v1/projects/:id/grants | 不存在用户 | `no-such-user` | 400 USER_NOT_FOUND | P3 |
| G4 | PUT /v1/projects/:id/grants | 不存在组 | `no-such-group` | 400 GROUP_NOT_FOUND | P3 |
| G5 | PUT /v1/projects/:id/grants | 空主体 | `subjectId:""` | 400 USER_NOT_FOUND | P3 |
| G6 | PUT /v1/projects/:id/grants | 全部 7 权限位（用户名） | `open…download` | 200 | P3 |
| G7 | GET /v1/projects/:id/grants | 用户名解析 | 授权后回读 | subjectId=用户 id 且回显 username | P3 |
| G13 | PUT /v1/projects/:id/grants | 开发者冒充 admin（有 open） | 全权限位 | 403 PERMISSION_DENIED + 审计 | P2 |
| G8 | PUT /v1/projects/:id/grants | 重复权限位 | `["open","open","terminal"]` | 200（集合语义） | P3 |
| G8b | GET /v1/projects/:id/grants | 重复位落库形态 | — | 应去重；实际原样保存 | P3 |
| G9 | PUT /v1/projects/:id/grants | permissions 类型错误 | `"open"`（字符串） | 应 400 且保留既有授权；实际 200 并静默撤销 | P2 |
| G9b | GET /v1/projects/:id/grants | 上述请求后的状态 | — | 既有授权保留（G9 同根因） | — |
| G11 | PUT /v1/projects/:id/grants | 非法 subjectType | `role` + 用户 id | 应 400；实际按 user 处理 200 | P3 |
| G12 | PUT /v1/projects/:id/grants | 组授权 | `team-payment` | 200 | P3 |
| G15 | GET /v1/projects/:id | 无授权用户读取 | lisi | 404 PROJECT_NOT_FOUND | P2 |
| G14 | PUT /v1/projects/:id/grants | 无授权用户写 | lisi | 404（不泄露存在性） | P2 |
| G16 | GET /v1/projects/:id | admin 无显式授权 | — | 200（admin 可见） | P3 |
| G10 | PUT /v1/projects/:id/grants | 空数组撤销 | `[]` | 200 且行删除 | P3 |

## Y. 策略

| ID | 端点 | 操作 | 边界样本 | 检查点 | 失配级 |
|----|------|------|----------|--------|--------|
| Y1 | GET /v1/policies/download | 读全局 | — | 200 downloadDefault/readRatePerHour/version | P3 |
| Y2 | PUT /v1/policies/download | 改 deny | `{downloadDefault:"deny"}` | 200 | P3 |
| Y3 | GET /v1/policies/download | 回读 | — | deny | P3 |
| Y4 | PUT /v1/policies/download | 恢复 | 基线值 | 200 | P3 |
| Y5 | PUT /v1/policies/download | 限速下界 | `{calls:1,bytes:1}` | 200 保存 | P3 |
| Y6 | GET /v1/policies/download | 限速回读 | — | 1/1 | P3 |
| Y8 | PUT /v1/policies/download | calls=0 | — | 400 POLICY_INVALID | P3 |
| Y9 | PUT /v1/policies/download | calls=-1 | — | 400 POLICY_INVALID | P3 |
| Y10 | PUT /v1/policies/download | calls=1.5 | — | 400 POLICY_INVALID | P3 |
| Y11 | PUT /v1/policies/download | calls="abc" | — | 400 POLICY_INVALID | P3 |
| Y12 | PUT /v1/policies/download | null（全局不可清） | `readRatePerHour:null` | 400 POLICY_INVALID | P3 |
| Y13 | PUT /v1/policies/download | 超大整数 | `1e300` | 应 400；实际 200 保存 | P3 |
| Y14 | PUT /v1/policies/download | 非法 downloadDefault | `banana` | 应 400；实际 200 静默 deny | P3 |
| Y15 | PUT /v1/policies/download | 开发者写全局 | — | 403 PERMISSION_DENIED | P2 |
| Y16 | GET /v1/projects/:id/policy | 继承全局 | — | 200 effective=全局 | P3 |
| Y17 | PUT /v1/projects/:id/policy | 覆写 deny | — | 200 且 explicit | P3 |
| Y18 | PUT /v1/projects/:id/policy | inherit 往返 | `{inherit:true}` | 200 回落全局 | P3 |
| Y19 | PUT /v1/projects/:id/policy | 项目限速设置 | `{calls:2,bytes:2048}` | 200 | P3 |
| Y20 | PUT /v1/projects/:id/policy | 清除项目限速 | `readRatePerHour:null` | 200 回落全局 | P3 |
| Y21 | PUT /v1/projects/:id/policy | 非法项目限速 | `{calls:0,bytes:1}` | 400 POLICY_INVALID | P3 |
| Y22 | PUT /v1/projects/:id/policy | 开发者写项目策略 | — | 403 PERMISSION_DENIED | P2 |
| Y23 | GET /v1/projects/:id/policy | 归档项目 | — | 404 PROJECT_NOT_FOUND | P3 |

## H. 宿主（令牌/注册/心跳/维护/授权/吊销/安装）

| ID | 端点 | 操作 | 边界样本 | 检查点 | 失配级 |
|----|------|------|----------|--------|--------|
| H1 | POST /v1/hosts/tokens | 管理员签发 | — | 201 token + expiresIn=86400 | P3 |
| H2 | POST /v1/hosts/tokens | 开发者签发 | — | 403 PERMISSION_DENIED | P3 |
| H3 | POST /v1/hosts/tokens | 无会话 | — | 401 SESSION_EXPIRED | P3 |
| H4 | POST /v1/hosts/register | 无效令牌 | `not-a-token` | 401 HOST_TOKEN_INVALID | P3 |
| H5 | POST /v1/hosts/register | 合法注册 | 探针宿主全字段 | 201 hostId/credential/policyVersion | P2 |
| H6 | POST /v1/hosts/register | 一次性令牌复用 | 同一 token 再注册 | 401 HOST_TOKEN_INVALID | P2 |
| H7 | POST /v1/hosts/register | 仅令牌、缺全部字段 | `{}` | 应 400；实际 201 空名宿主 | P3 |
| H8 | POST /v1/hosts/register | directAddrs 元素非字符串 | `[123]` | 应 400 且令牌可复用；实际 500 且令牌被烧 | P2 |
| H44 | POST /v1/hosts/register | protocolVersion 非数字 | `"not-a-number"` | 应 400/合法整数；实际 201 存 NaN→null | P3 |
| H10 | POST /v1/hosts/:id/heartbeat | 错误凭证 | `wrong-credential` | 401 HOST_CREDENTIAL_INVALID | P2 |
| H11 | POST /v1/hosts/:id/heartbeat | 合法心跳 | status=online + addr | 200 | P3 |
| H12 | POST /v1/hosts/:id/heartbeat | status 任意串 | `banana` | 200（随后检查落库） | P3 |
| H12b | GET /v1/hosts | 落库结果 | — | 应拒绝非法 status；实际静默 offline | P3 |
| H14 | POST /v1/hosts/:id/heartbeat | directAddrs 元素非字符串 | `[123]` | 应 400 不落库；实际 500 + 落库 + 项目列表 500 | **P1** |
| H17 | POST /v1/hosts/:id/heartbeat | 坏心跳后恢复 | 合法 addr | 200 + 项目列表恢复 200 | P3 |
| H18 | POST /v1/hosts/:id/heartbeat | 非法 projectsRoot | `relative/path` | 应明确告知拒绝；实际静默忽略 | P3 |
| H19 | POST /v1/hosts/:id/heartbeat | 有活跃项目时改 root | 新 root | 200 + projectsRootRejected | P3 |
| H21 | POST /v1/hosts/:id/maintenance | 开启维护 | enabled=true | 200 status=maintenance | P3 |
| H22 | POST /v1/hosts/:id/heartbeat | 维护中心跳 | status=online | 状态保持 maintenance + reason | P3 |
| H23 | POST /v1/hosts/:id/maintenance | enabled 为字符串 "false" | `"false"` | 应 400 或按 false；实际进入维护 | P3 |
| H24 | POST /v1/hosts/:id/maintenance | 关闭维护 | enabled=false | 200 status=online | P3 |
| H24b | POST /v1/hosts/:id/maintenance | 再次恢复在线 | enabled=false | 200 status=online | P3 |
| H24c | GET /v1/projects/:id | 退出维护后的 projectView | — | 应无 hostMaintenanceReason；实际残留 | P3 |
| H25 | POST /v1/hosts/:id/maintenance | 未授权开发者 | zhangsan 无 host grant | 403 PERMISSION_DENIED | P3 |
| H26 | PUT /v1/hosts/:id/grants | 委派 maintain | zhangsan | 200 | P2 |
| H27 | POST /v1/hosts/:id/maintenance | 持 maintain 的开发者 | zhangsan | 200 status=maintenance | P2 |
| H29 | PUT /v1/hosts/:id/grants | 非法宿主权限位 | `root` | 400 HOST_GRANT_PERMISSION_INVALID | P3 |
| H30 | PUT /v1/hosts/:id/grants | 不存在用户 | `no-such-user` | 400 USER_NOT_FOUND | P3 |
| H31 | GET /v1/hosts/:id/grants | 管理员列表 | — | 200 | P3 |
| H32 | GET /v1/hosts/:id/grants | 开发者列表 | — | 403 PERMISSION_DENIED | P3 |
| H33 | PUT /v1/hosts/:id/provision-policy | 非法 mode | `nope` | 400 HOST_PROVISION_POLICY_INVALID | P3 |
| H34 | PUT /v1/hosts/:id/provision-policy | restricted | — | 200 | P3 |
| H36 | GET /v1/hosts/available | restricted 对开发者 | zhangsan | provisionAllowed=false | P2 |
| H35 | POST /v1/projects/self | restricted 上自助建项目 | 探针宿主 | 403 HOST_PROVISION_FORBIDDEN | P2 |
| H37 | PUT /v1/hosts/:id/provision-policy | open | — | 200 | P3 |
| H38 | POST /v1/projects/self | open 上自助建项目 | 探针宿主 | 201 | P3 |
| H39 | DELETE /v1/hosts/:id | 吊销 | — | 200 | P3 |
| H40 | DELETE /v1/hosts/:id | 重复吊销 | — | 200（幂等） | P3 |
| H41 | POST /v1/hosts/:id/heartbeat | 吊销后心跳 | 有效凭证 | 200 hostRevoked=true | P2 |
| H42 | POST /v1/hosts/:id/maintenance | 吊销后维护 | — | 409 HOST_REVOKED | P2 |
| H43 | DELETE /v1/hosts/host_missing | 不存在主机 | — | 404 HOST_NOT_FOUND | P3 |
| H45 | GET /install/host.sh | 无会话 | — | 401 SESSION_EXPIRED | P3 |
| H46 | GET /install/host.sh?token=bad | 无效令牌 | — | 401 HOST_TOKEN_INVALID | P3 |
| H47 | GET /install/host.sh?token=… | 管理员+有效令牌 | 新签发 token | 200 shell 且内嵌 token | P3 |
| H48 | GET /install/host.sh?token=… | 开发者 | — | 403 PERMISSION_DENIED | P3 |
| H49 | GET /install/relay.sh | 管理员 | — | 200 shell | P3 |

## D. Web Handoff（签发/兑换/TTL/并发）

| ID | 端点 | 操作 | 边界样本 | 检查点 | 失配级 |
|----|------|------|----------|--------|--------|
| D1 | POST /v1/projects/:id/web-handoff | web surface 签发 | `{}` | 201 web-index + expiresIn=60 | P3 |
| D2 | POST /v1/projects/:id/web-handoff | admin surface 签发 | `{surface:"admin"}` | cloud-admin.html + embed=1&project=id | P3 |
| D3 | POST /v1/projects/:id/web-handoff | 未知 surface | `bogus` | 回落 web-index | P3 |
| D4 | POST /v1/projects/:id/web-handoff | 无 open 权限 | lisi | 404（不泄露存在性） | P3 |
| D5 | POST /v1/projects/:id/web-handoff | 归档项目签发 | — | 404 PROJECT_NOT_FOUND | P3 |
| D6 | POST /v1/projects/:id/web-handoff | provisioning + web | — | 201（web 保持旧行为） | P3 |
| D7 | POST /v1/projects/:id/web-handoff | provisioning + admin | `surface:admin` | 409 PROJECT_PROVISIONING | P3 |
| D8 | POST /v1/projects/:id/web-handoff | failed + admin | 心跳报失败后 | 409 PROJECT_NOT_PREPARED | P3 |
| D9 | POST /v1/web/handoff | 无效 code | `not-a-code` | 410 HANDOFF_GONE reason=code_invalid | P3 |
| D10 | POST /v1/web/handoff | 缺 code | `{}` | 410 HANDOFF_GONE | P3 |
| D11 | POST /v1/web/handoff | 合法兑换 + 重放 | 同一 code 两次 | 首次 200，重放 410 | P3 |
| D12 | POST /v1/web/handoff | 并发兑换 | 同一 code 两路 | 恰好一个 200、一个 410 | P2 |
| D15 | POST /v1/web/handoff | 签发后撤权 | 移除 user+group 授权 | 403 PROJECT_FORBIDDEN reason=permission_lost | P2 |
| D16 | POST /v1/web/handoff | 签发后归档 | — | 410 HANDOFF_GONE | P3 |
| D13 | POST /v1/web/handoff | TTL 下边界 | 等待 58s 兑换 | 200 | P2 |
| D14 | POST /v1/web/handoff | TTL 上边界 | 等待 62s 兑换 | 410 HANDOFF_GONE | P2 |
| D14b | POST /v1/web/handoff | 过期 reason 稳定性 | 62s 兑换 | reason=code_expired；并发签发触发 prune 时可能变 code_invalid（契约仍为 410） | P3 |

## C. Connect

| ID | 端点 | 操作 | 边界样本 | 检查点 | 失配级 |
|----|------|------|----------|--------|--------|
| C1 | POST /v1/projects/:id/connect | 缺 deviceId | `{clientVersion:"1.5.0"}` | 401 DEVICE_NOT_REGISTERED | P3 |
| C2 | POST /v1/projects/:id/connect | 版本过低 | `1.4.9` | 426 VERSION_UNSUPPORTED | P3 |
| C3 | POST /v1/projects/:id/connect | 非法版本串 | `abc` | 426 VERSION_UNSUPPORTED | P3 |
| C4 | POST /v1/projects/:id/connect | 合法 | `1.5.0` + 本人 device | 200 credential/endpoints/workspace | P3 |
| C5 | POST /v1/projects/:id/connect | 设备公钥不匹配 | 不同 devicePubKey | 401 DEVICE_KEY_MISMATCH | P2 |
| C6 | POST /v1/projects/:id/connect | 归档项目 | — | 404 PROJECT_NOT_FOUND | P3 |
| C7 | POST /v1/projects/:id/connect | 无 open 权限用户 | lisi | 404 PROJECT_NOT_FOUND | P2 |

## U. 审计

| ID | 端点 | 操作 | 边界样本 | 检查点 | 失配级 |
|----|------|------|----------|--------|--------|
| U1 | GET /v1/audit/events | traceId 贯穿 | 请求头 `x-trace-id` | 按 traceId 查到对应 project_create | P2 |
| U2-<type> | GET /v1/audit/events | 敏感操作落链 | 16 类事件 | 每类至少 1 条 | P2 |
| U3 | GET /v1/audit/verify | 链完整性 | — | 200 ok=true checked>0 | P0 |
| U4 | GET /v1/audit/status | 落盘状态 | — | 200，persisted 为布尔 | P3 |
| U5 | GET /v1/audit/events | limit=1 | — | 1 条 + nextCursor 非空 | P3 |
| U6 | GET /v1/audit/events | cursor 翻页 | 首页 nextCursor | 更旧一条，seq 更小 | P3 |
| U7 | GET /v1/audit/events | limit 上限 | `limit=201` | ≤200 条 | P3 |
| U8 | GET /v1/audit/events | limit 边界 | `0` / `-1` / `abc` | 应有界/拒绝；实际全量返回（1732/1731/1732） | P2 |
| U11 | GET /v1/audit/events | 时间窗上限 | 32 天前 | 400 TIME_WINDOW_TOO_LARGE | P3 |
| U12 | GET /v1/audit/events | 非法日期 | `since=not-a-date` | 应 400；实际 200 忽略过滤 | P3 |
| U13 | GET /v1/audit/events | 非法 cursor | `cursor=abc` | 应 400；实际 200 忽略 cursor | P3 |
| U14 | GET /v1/audit/events | 开发者读审计 | — | 403 PERMISSION_DENIED | P2 |

`U2-<type>` 覆盖：`login`、`logout`、`project_create`、`project_update`、`project_archive`、`project_restore`、`project_connect`、`grant_update`、`policy_update`、`host_token_create`、`host_register`、`host_maintenance`、`host_grant_update`、`host_provision_policy_update`、`web_handoff`、`audit_verify`。

## R. 中继 / internal / CORS

| ID | 端点 | 操作 | 边界样本 | 检查点 | 失配级 |
|----|------|------|----------|--------|--------|
| R1 | GET /v1/relays | 形态 | admin | 200，每项含 id/host/browserHost/port/online/lastSeenAt | P3 |
| R2 | GET /v1/relays | 开发者 | — | 403 PERMISSION_DENIED | P3 |
| R3 | GET /v1/internal/relays | 无令牌 | — | 401 | P3 |
| R4 | GET /v1/internal/relays | 带令牌 | `x-internal-token` | 200 | P3 |
| R5 | GET /v1/internal/policy | 无令牌 | — | 401 | P3 |
| R6 | GET /v1/internal/policy | 带令牌 | — | 200 | P3 |
| R7 | GET /v1/internal/revocations | 带令牌 | — | 200 | P3 |
| R8 | GET /v1/internal/relay-routes | 带令牌 | — | 200 | P3 |
| R9 | GET /v1/internal/relay-routes | 无令牌 | — | 401 | P3 |
| R13 | GET /v1/internal/not-a-route | 未知内部路径 | — | 404 | P3 |
| R10 | POST /v1/internal/relay-endpoint | 无令牌 | `{port:18443}` | 401 INTERNAL_TOKEN_INVALID | P2 |
| R11a | POST /v1/internal/relay-endpoint | port=0 | — | 400 RELAY_PORT_INVALID | P3 |
| R11b | POST /v1/internal/relay-endpoint | port=70000 | — | 400 RELAY_PORT_INVALID | P3 |
| R11c | POST /v1/internal/relay-endpoint | port="abc" | — | 400 RELAY_PORT_INVALID | P3 |
| R11d | POST /v1/internal/relay-endpoint | 缺 port | — | 400 RELAY_PORT_INVALID | P3 |
| R14 | GET /v1/me | CORS 白名单 | Origin=宿主直连地址 vs evil.example | 仅白名单回显 ACAO | P3 |
| R15 | OPTIONS /v1/me | 预检 | 白名单 Origin | 204 + allow-methods | P3 |

## W. 静态资源 / Web 契约 / 方法语义

| ID | 端点 | 操作 | 边界样本 | 检查点 | 失配级 |
|----|------|------|----------|--------|--------|
| W1 | GET /v1/web/release | 公开清单 | — | 200 contract/minContract/build/assets | P3 |
| W2 | GET /v1/me | 契约过新 | `x-orca-web-contract:2` | 426 | P3 |
| W3 | GET /v1/me | 契约非法 | `abc` | 426 | P3 |
| W4 | GET /v1/me | 契约匹配 | `1` | 200 | P3 |
| W5 | GET /%E0%A4%A | 非法百分号转义 | — | 应 400/404；实际 500 URI malformed | P3 |
| W6 | GET /%2e%2e/…/etc/passwd | 编码路径穿越 | — | 404，不泄露 webRoot 外文件 | P0 |
| W7 | GET /v1/does-not-exist | 未知 API | — | 404 NOT_FOUND | P3 |
| W8 | DELETE /v1/projects | 集合端点错误方法 | — | 404（或 405） | P3 |
| W9 | GET /v1/projects | 无会话 | — | 401 SESSION_EXPIRED | P2 |
| W10 | GET /v1/projects/proj_missing | 错误响应 traceId | 请求头 `x-trace-id` | error.traceId 回显调用方值 | P3 |

## M. 其他管理/公开端点

| ID | 端点 | 操作 | 边界样本 | 检查点 | 失配级 |
|----|------|------|----------|--------|--------|
| M1 | GET /health | 健康检查（公开） | — | 200 ok=true | P3 |
| M2 | GET /v1/client/config | 客户端配置（公开） | — | 200 managed/supportsDirect | P3 |
| M3 | GET /v1/jwks | JWKS（公开） | — | 200 keys 数组，每项有 kid | P3 |
| M4 | GET / | 静态入口 | — | 200 text/html | P3 |
| M5 | GET /v1/me | 当前身份 | admin | 200 roles 含 platform:admin | P3 |
| M6 | GET /v1/me/devices | 设备列表形态 | admin | 200 devices 数组 | P3 |
| M7 | GET /v1/directory | 授权目录 | admin | 200 users/groups 数组 | P3 |
| M8 | GET /v1/directory | 授权目录越权 | zhangsan | 403 PERMISSION_DENIED | P2 |
| M9 | POST /v1/admin/signing-keys/rotate | 密钥轮换 | admin | 200 kid/previousKid/publishedKids | P3 |
| M10 | POST /v1/admin/signing-keys/rotate | 密钥轮换越权 | zhangsan | 403 PERMISSION_DENIED | P2 |
| M11 | DELETE /v1/me/devices/:id | 删除他人设备 | admin 删除 zhangsan 设备 | 404 NOT_FOUND | P2 |
| M12 | DELETE /v1/me/devices/:id | 删除本人设备 | 一次性会话设备 | DELETE 200，随后 access token 401 | P2 |

## ENV. 环境守护

| ID | 操作 | 检查点 |
|----|------|--------|
| ENV-project-create / self-service / handoff / connect / audit-trace | 等待 `dev-local-02` 恢复 online（最多 90s，不修改状态） | 若超时记环境事件，后续用例可能级联 |

---

## 本次结果

以 `api.json` 为准。最终一次运行：254 用例，232 通过，22 失配（1×P1、4×P2、17×P3；其中 A5/A6 为重复运行把固定探针用户名锁定后的环境伪差，不计产品缺陷）。清理结果见 `api.json.cleanup`：全部探针项目 `archive` 返回 200，探针宿主 `DELETE` 返回 200，全局策略恢复返回 200。
