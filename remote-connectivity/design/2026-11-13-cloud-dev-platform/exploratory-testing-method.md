# 云端开发平台 · 探索性测试方法

> 版本：1（2026-11-15）
> 定位：把本周期 M116 探索、W12b 独立探针、U46-8 真栈旅程、exploratory-r2 四路探索、链路覆盖审计中的做法固化为可复用方法。
> 适用：云端开发平台 Web 管理台、同页简易工作区、Orca Web、桌面 Electron 客户端、平台 API 与原型对照。
> 约束：探索只读或可逆；证据留盘不入库；路径清单与脚本入库；不抢焦点、不改产品代码、不提交 git。

## 本周期素材索引

| 素材 | 本文使用方式 |
| --- | --- |
| `parent-child-session-protocol.md` §2b/§3a/§3b | 并行探索、证据留存、路径复用的制度来源 |
| `test-reports/exploratory-qa-web.md` | 第一轮 Web 管理台探索的完整样本（M116，33 条） |
| `defect-ledger.md` U1–U52 | 「探索如何发现问题」的案例库 |
| `test-reports/chain-coverage-audit.md` | 真实度分级 R1–R0、截图不构成覆盖、mock 不得作为链路证据 |
| `test-reports/u46-batch-audit.md`、`m120-batch-audit.md` | 批量审计与变异抽查方法 |
| `work-orders/playwright-server-design.md` | 两层脚本、常驻探索、原型对照的设计基线 |
| `cloud-platform/scripts/local-env-reseed.mjs` | 真实数据面与身份矩阵 |
| `cloud-platform/scripts/exploratory-r2/` | API、同页工作区、Electron 桌面三类探索脚本实物 |

---

## 1. 目标与定位：探索与回归的分工

### 1.1 两类测试回答不同问题

| 维度 | 探索性测试 | 回归测试 |
| --- | --- | --- |
| 回答的问题 | 「还有哪些我们没想到的坏法？」 | 「已经修好的，还会不会再坏？」 |
| 输入 | 页面/控件/边界的三维组合、真实数据面、原型对照 | 已固化的路径清单、黄金旅程、验收用例 |
| 产物 | findings（证据，留盘）+ 新增/修订后的路径清单（入库） | 可重复执行的脚本/spec 与通过/失败结论 |
| 判定 | 发现是否被解释、分级、登记、闭环；覆盖是否成矩阵 | 全绿且断言真实（非空断言、非截图） |
| 节奏 | 每个开发批次前后、用户验收前、缺陷修复后 | 每次提交/每波集成/发版前 |

结论一句话：**探索负责扩大已知边界，回归负责守住已知边界；两者共用同一份路径资产。**

### 1.2 两层脚本共用

据 `work-orders/playwright-server-design.md` §3：

- 第一层 `ui`：稳定语义操作，`login/openProject/tab/click/fill/discover/screenshot/assertText`，面向探索代理，降低选择器噪声。
- 第二层原生 Playwright：`page/locator/frameLocator/expect` 随时下落，面向回归脚本。
- 单文件 `defineJourney({ run })`：服务模式由常驻 server 注入 `ui/page`；独立模式 `node journey.mjs` 启动临时 Chromium 执行同一个 `run`。
- 断言语义随模式变化：探索模式失败记录 `{ok:false,step,expected,actual}` 后继续；回归模式立即抛出并以退出码 1 结束。

### 1.3 探索与回归的转化规则

1. 每次探索产出两类资产：**一次性 evidence**（findings、截图、日志，`cloud-platform/evidence/<轮次>/`，gitignored）与**可复用路径**（`cloud-platform/scripts/exploratory-<轮次>/`，入库）。
2. 修复完成后，把用户精确场景或探索路径追加为回归用例；**追加，不重写**。
3. 回归失败时，按失败点开一次小范围探索，而不是只把断言改绿。

### 1.4 判定标准

- 一个探索轮次可关闭，需同时满足：三维覆盖矩阵无空洞；边界输入库每类至少命中一次；所有 finding 有编号、分级、去向；路径清单可被他人按命令重放。
- 一个回归套件可信，需满足：真实组件参与（链路步骤至少 R1/R2）、断言打在行为上、最近执行时间在有效期内。截图、mock、echo 替身只能作辅助，不能作为链路结论。

---

## 2. 探索前准备

### 2.1 环境健康检查

**怎么做**

1. 用持久化脚本重建环境，不使用手工拼装：
   ```bash
   node cloud-platform/scripts/local-env-reseed.mjs
   ```
   脚本幂等，`exit 0` 表示平台、双主机、项目、授权、中继路由、三身份登录、handoff 全部通过。
2. 核对关键外部条件：平台 `https://127.0.0.1:18787` 可达；宿主在线；中继 `routes synced n=2`；CA 已入钥匙串；`out/web` 与 `out/main` 是当日构建（避免 U3 的 0 字节挂起、U36 的构建 env 敏感问题）。
3. Electron 侧遵循 AGENTS.md：`ORCA_BACKGROUND_LAUNCH=1`、headless、隔离 HOME/userData，不 `show()`、不抢焦点；截图走 CDP。

**判定标准**：reseed 退出码为 0，且健康探测逐项有输出；任一前置失败先修环境，不把环境故障记成产品缺陷（U3 的教训：先分清 D1 环境/构建问题与产品行为）。

### 2.2 真实数据面核对

**怎么做**

1. 记录当前数据面基线：项目数、主机数、策略版本、关键项目与工作树。
2. 优先使用真实平台进程 + 真实宿主 + 真实中继/PTY；`runtime-sim`、echo 替身、scripted host 只能证明局部，不能证明链路（R2/R3）。
3. 多主机、多项目、跨主机可见性必须真实存在，否则跨主机路径无法探索。

本周期种子事实（`local-env-reseed.mjs`）：

| 对象 | 内容 |
| --- | --- |
| 主机 | `dev-local-02`、`dev-local-03`，各自独立边界与证书 SAN |
| 项目 | `demo-app`、`zhangsan-demo`、`infra-tools`、`zhangsan-lab` |
| 授权 | 组 `team-payment` FULL；`zhangsan` FULL；`lisi` READ_ONLY；`admin` FULL |
| 账号 | `admin/Adm1n!`、`zhangsan/Passw0rd!`、`lisi/Passw0rd!` |

**判定标准**：探索路径中每条都标注了它依赖的数据对象；数据对象缺失时路径记为「不可执行」，不记为「通过」。

### 2.3 身份矩阵

**怎么做**

每条路径至少覆盖四类主体，并把「无权」当作正式检查点：

| 身份 | 能力 | 必测点 |
| --- | --- | --- |
| `admin` | 管理台全功能；本项目已补全量授权 | 管理入口、授权、策略、审计、任意项目打开 |
| `zhangsan` | 开发者；`team-payment` FULL；可自助建项目 | 正常使用链、自助项目私有性、无管理入口 |
| `lisi` | 受限；READ_ONLY；跨主机仅见 `demo-app` | 最小权限、越权拒绝、跨主机不可见 |
| 匿名/过期会话 | 无凭据或 token 失效 | 401/403、登录页回落、denied 审计 |

**判定标准**：同一操作在不同身份下结果不同且符合授权模型；开发者直接调用管理 API 必须 403 且写 denied 审计；管理员「看得见」不等于「有权限」，须同时核对凭证 `perms`（U40 即此盲区）。

### 2.4 可逆操作纪律

**怎么做**

1. 执行前抓基线：项目数、主机数、策略值、授权行（API 探索用 `snapshotBefore` 形态）。
2. 所有临时资源带唯一后缀（时间戳/随机串），命名可识别、可批量清理。
3. 用 `finally`/`cleanup` 收尾：归档临时项目、吊销临时主机、恢复策略原值；保留种子数据。
4. 只读优先；需要写操作时，路径条目必须显式标记「可逆」及清理动作。
5. 不触碰用户正在使用的实例与主工作树；探索实例用快照或独立 `ORCA_LOCAL_ENV_ROOT`。

**判定标准**：探索结束后 `cleanup.ok=true`，基线对比无净增；临时记录即使残留也必须是惰性记录且在报告中声明。无法清理的操作不执行，或先取得明确确认。

---

## 3. 探索路径组织

### 3.1 条目格式：入口 → 步骤 → 检查点

每条路径是一个可重放的最小单元，固定六段：

```text
E-<域>-<序号>: <一句话目的>
入口:     页面/路由/API endpoint + 身份
前置:     数据对象、会话、构建、feature flag
步骤:     1) ... 2) ... 3) ...
检查点:   C1 期望=...；观察方式=DOM/网络/截图/日志
清理:     归档/吊销/恢复/无
```

示例（M116 用户级授权路径的抽象）：

```text
E-members-03: 用户级授权应真实生效且不误伤会话
入口:       管理台 → 成员与权限 → grant-fixture-probe；admin
前置:       项目已授予组 team-payment；zhangsan 在线会话存在
步骤:       1) admin 以 zhangsan/用户 授予基础权限
            2) 矩阵确认出现 zhangsan ✓
            3) zhangsan 调 GET /v1/projects
            4) 检查原在线会话是否仍存活
检查点:     C1 项目对 zhangsan 可见（当前失败，QA-001）
            C2 授权记录落到 user_<uuid>（当前失败）
            C3 旧会话不被误撤销（当前失败）
清理:       无写产品数据；测试项目最后归档
```

**判定标准**：别人只读条目即可重放；每个检查点有「期望 + 观察方式」；没有观察方式的检查点视为无效。

### 3.2 页面 × 控件 × 边界三维覆盖

**怎么做**

1. 页面维：列出全部 surface（登录、工作台、我的项目、主机、中继、成员与权限、审计、设置、门禁、工作区、诊断）。
2. 控件维：每页清点导航、表单字段、表格列/行操作、主按钮、弹层、抽屉、菜单项、上下文菜单、空态/加载态入口。
3. 边界维：每个控件至少挂一类边界（空、超长、unicode、特殊字符、重复提交、权限、加载失败、竞态、断线、超时）。
4. 形成矩阵后，空白格就是下一轮路径；不按「我觉得重要」抽样。

本周期覆盖样本：

| 战线 | 实物 | 规模 |
| --- | --- | --- |
| Web 管理台 | M116 报告 + `evidence/m116-exploratory-web/findings.json` | 9 个 surface，33 条 finding |
| 平台 API | `scripts/exploratory-r2/run-api-exploratory.mjs` | 13 个 area、251 个 case、51 个端点 |
| 同页工作区 | `scripts/exploratory-r2/run-workspace-exploration.mjs` | 15 个 section（A–O）、51 个 check |
| Electron 桌面 | `desktop-harness.mjs` + `driver-*.mjs` | 登录、激活、终端、菜单、行 DOM、运行时探针、RPC |
| 原型对照 | `ui/prototype.html` + 实际 Web | 11 个 surface、三类差异 |

### 3.3 路径清单入库

**怎么做**

1. 每个轮次建目录：`cloud-platform/scripts/exploratory-<轮次>/`。
2. 目录内至少两份资产：
   - `paths.md`（或 `paths.json`）：结构化路径条目，**入库**；
   - `run-*.mjs` / `driver-*.mjs`：可执行实现，**入库**。
3. 以下内容**不入库**：findings JSON、截图、控制台/网络日志、运行日志，统一放 `cloud-platform/evidence/<轮次>/`（`.gitignore` 已忽略 `cloud-platform/evidence/`）。
4. 路径与脚本用同一套 ID；finding 里的 `pathId` 指回路径条目。

**判定标准**：新代理只看 `scripts/exploratory-<轮次>/paths.md` 就能复跑；证据目录删掉不影响路径资产；路径清单没有「一次性截图路径」这种不可重放条目。

### 3.4 覆盖判定

- 每个页面：至少 1 条正常路径 + 1 条边界路径 + 1 条权限路径。
- 每个可交互控件：至少出现在一条路径的步骤中。
- 每条核心链路：至少 1 条端到端路径，且断言落在业务结果而非页面存在。
- 未覆盖项必须显式登记为「未覆盖及原因」，不能以沉默代替覆盖（参考 M116 §六）。

---

## 4. 边界输入策略库

### 4.1 表单输入

| 类别 | 输入 | 期望 | 本周期例证 |
| --- | --- | --- | --- |
| 空/纯空白 | 空串、空格、Tab、换行 | 前端必填拦截，不发请求、不计失败次数 | M116-QA-012：空账号密码连续提交 5 次触发账号锁定 |
| 超长 | 边界值、边界+1、1k、100k | 明确 400/字段错误，不截断后成功、不 500 | 项目 name ≤200、key 语法校验（U18/U25） |
| unicode | 中文、emoji、组合字符、NFC/NFD、RTL、零宽字符 | 原样保存或明确拒绝；展示不崩、不截断乱码 | API P21：Unicode 名称与路径 |
| 特殊字符 | 引号、`<script>`、`../`、`\`、`%00`、CRLF | 转义或拒绝；不执行、不越界、不注入 | M116 已验证主体名 XSS 载荷被安全转义 |
| 类型错误 | 数字传字符串、数组传对象、布尔传 `"false"` | 400 且不落库；不能 500、不能静默改写 | API H14：`directAddrs` 元素非字符串导致 500，并连带 `GET /v1/projects` 500 |
| 重复提交 | 双击、并发、请求重试 | 一次生效或幂等；计数/版本不双增 | M116-QA-025：双击保存产生两次 PUT、版本 +2 |
| 缺失字段 | 只传必填子集、缺 token、缺 body | 明确错误码；一次性令牌不被消耗 | API H8：错误输入 500 且令牌被消耗，重试 401 |

**判定标准**：每个输入都有「期望状态码/错误码/UI 状态/副作用」四要素；只验证「页面没崩」不算通过。

### 4.2 API 输入

1. **缺字段/多字段**：必填缺失、未知字段、`null` 与缺省的区别。
2. **类型错**：字符串/数字/布尔/数组/对象互换；嵌套元素类型错误。
3. **边界值**：0、负数、超大整数、浮点、超长数组、空数组、重复元素。
4. **路径穿越**：`../`、绝对路径、`%2e%2e`、Windows 分隔符、UNC 路径；必须落在项目 `projectsRoot`/工作树边界内。
5. **幂等与重放**：重复吊销、重复归档、refresh 旧 token、handoff code 重放、重复授予。
6. **权限矩阵**：admin/developer/受限用户/匿名 × 端点；拒绝必须带 denied 审计。
7. **错误语义一致性**：状态码、错误码、文案、审计四者一致；不允许 500 暴露内部、不允许静默成功。
8. **响应形状**：新增字段必须可选（wire-additive），旧客户端不因新字段失败。

本周期 API 探索实绩：251 个 case 中 20 个不匹配，其中 P1 1 条（错误类型污染全局状态）、P2 4 条（授权被静默清空等）、P3 15 条（非法值被静默改写或接受）。这些不是「多测出来的噪音」，而是下一轮修复和回归的输入。

**判定标准**：每个端点至少覆盖正常、缺字段、错类型、未授权、不存在资源；每个写端点至少覆盖一次重复调用；每个拒绝路径核对审计。

### 4.3 交互与状态

| 场景 | 操作 | 期望 | 本周期例证 |
| --- | --- | --- | --- |
| 快速连点 | 连续点击保存/授予/打开 | 按钮冻结或请求去重；不产生双记录 | QA-025 双击保存 |
| 导航竞态 | 慢请求未返回时切换页面 | 迟到响应不覆盖当前页；有请求序号/取消 | QA-022 面包屑「中继」+ 内容「主机」 |
| 会话过期中操作 | 操作中 access token 过期 | 静默 refresh 并重放；refresh 失效回登录页 | M116 已验证恢复链 |
| 断线恢复 | 终端/流式连接断开后重连 | 重新签票、状态可恢复、不重复消费一次性票据 | U14：复用同一张一次性票据被拒 `replayed` |
| 弹层超时 | iframe/工作区 ready 超时 | 失败态 + 重试 + 逃生入口，不静默移除 | U51 F-02：20s 超时只移除覆盖层 |
| 脏状态关闭 | 有未保存编辑时关闭标签 | 保存/放弃/取消三选，不能静默丢稿 | U51 F-01 |
| 刷新/后退 | 页面刷新、浏览器后退 | 路由与状态可恢复；不回到错误首页 | QA-023：刷新回工作台、hash 路由失效 |
| 跨主机/跨项目切换 | 双主机、多项目间切换 | 会话、工作树、权限不串 | 多主机种子与跨主机可见性矩阵 |

**判定标准**：每个交互场景至少检查「最终可见状态 + 服务端状态 + 副作用」三者一致；竞态类场景必须重复运行，单次通过不算稳定。

---

## 5. 原型对照方法

### 5.1 两侧输入与双轮清点

**怎么做**

1. 同一个 `extractDomInventory(page|frame)` 同时驱动两侧，避免「原型用 HTML 解析器、实际用 DOM」造成 schema 漂移。
2. 原型侧：`file://` 打开 `ui/prototype.html`，按 `data-route`/`data-page` 切换；隐藏的 dialog/drawer/menu 也在静态 DOM 中，一并清点。
3. 实际侧：登录后按真实路由导航；工作区在同页 overlay + `cloud-admin.html` iframe。
4. 角色双轮：`admin` 与 `developer` 各跑一遍，覆盖原型的前端角色门禁。

### 5.2 归一化清单

统一 schema（节选）：`surface/title/breadcrumb/nav/sections/stats/tables/fields/actions/menus/dialogs/drawers/frames/tokens`。归一化规则：NFC、去首尾空白、折叠空白、剥离可选标记（`· 只读`、`（二期）`）、维护显式别名表。

### 5.3 三类差异检测

| 类 | 对象 | 方法 | 分级 |
| --- | --- | --- | --- |
| 布局 | 页面存在性、导航分组/顺序、区块顺序、统计卡、表格列、面包屑 | 有序列表 LCS；逐路由可达性探测（reached/forbidden/missing） | 缺页面/缺主导航=P0；列/区块增删或重排=P1；顺序微调=P2 |
| 字段 | label、类型、必填、禁用/只读、placeholder、选项、帮助文案 | 精确匹配 → 别名表 → Dice ≥0.75 → missing；再比属性 | 缺字段/必填性变化=P1；文案/可选性变化=P2 |
| 菜单 | 侧栏项、页面动作、上下文菜单、dialog 按钮、抽屉动作 | 标签 + role 集合比对；对每项在实际页用 `getByRole`/`getByText` 试探，记 `exact/renamed/missing` | 缺动作/菜单项=P1；禁用态或文案变化=P2 |

### 5.4 补充手段与判定

补充手段：`ariaSnapshot()` 去 class 依赖；role/label/text 选择器试探定位「改名但仍在」；固定 1440×900 并排截图只作人工复核；控制台/网络作为差异附注；只比结构/形状，不比演示值。

本周期设计自检的 6 条已知差异：侧栏「项目授权/下载策略」→「成员与权限/平台设置」；工作台统计卡四项不同；「全部项目」7 列 → 6 列无「最近使用」；`#/diagnostics` 页面缺失；P3 原型是独立路由 → 实际是同页 overlay + iframe；登录框 id `loginAccount/loginPassword` → `username/password`。

**判定标准**：对照工具能稳定报出这 6 条；报告每条带类目、严重度、原型证据、实际证据、建议；像素差异与字体渲染差异不作为门禁。

---

## 6. 证据纪律

### 6.1 两类产物严格分离

| 产物 | 位置 | 是否入库 | 内容 |
| --- | --- | --- | --- |
| 路径清单与脚本 | `cloud-platform/scripts/exploratory-<轮次>/` | 是 | 可重放的入口、步骤、检查点、可执行实现 |
| 一次性证据 | `cloud-platform/evidence/<轮次>/` | 否（gitignored） | findings、截图、控制台、网络、运行日志 |

依据：`parent-child-session-protocol.md` §3a/§3b。规则的目的不是省仓库空间，而是让**可复用资产**与**不可复用现场**不互相污染。

### 6.2 证据文件规范

```text
cloud-platform/evidence/<轮次>/
  findings.json          # 机器可读：id/area/severity/expected/actual/pathId/evidence
  api.json               # API 汇总：summary/findings/cleanup/baseline/fatal
  api-raw.json           # 每个 case 的请求与原始响应
  workspace.json         # check 列表、meta、network、findings、screenshots
  screenshots/           # <area>-<check>-<state>.png
  console/               # 每场景一个 JSON：console/pageerror/4xx-5xx/requestfailed
  logs/                  # 带时间戳的运行日志
```

命名与内容要求：

1. 截图：默认 1440×900，关键页补 1280×900；文件名含 area、检查点、状态（如 `members-user-grant-added.png`）。
2. JSON：`expected` 与 `actual` 必须写**观察到的原文**，不能只写预期（U27 的教训：只记预期、不记观察输出，导致证据不可从提交复现）。
3. 日志：保留命令、HEAD/提交号、环境根、种子数据、起止时间。
4. 脱敏：不写入 token、密码、私钥；账号标识按需替换；共享前检查截图与日志。
5. 原始响应优先：API 证据保留状态码、headers、body 原文；不要只写「失败」。

### 6.3 判定标准

- 一条 finding 被接受，必须同时具备：可重放命令/路径 ID、观察原文、至少一种可视化或机器证据（截图/JSON/日志）、严重级建议。
- 只有截图没有断言，不算覆盖（链路审计已证明截图型「验证」失败不红）。
- 证据无法复现的 finding 不关闭，转为「待补证」；脚本自身缺陷必须与产品缺陷分开记录。

---

## 7. 严重级定义

### 7.1 四级定义

| 级别 | 定义 | 判定问题 | 处置 |
| --- | --- | --- | --- |
| P0 | 核心功能不可用、数据损坏/丢失、安全边界被突破 | 用户能否完成主任务？是否丢数据或越权？ | 立即登记并派修，阻塞验收 |
| P1 | 交互错误或强误导，但有绕行；边界失败暴露真实缺陷 | 用户是否被错误引导/产生错误状态？ | 本批修复或明确排期 |
| P2 | 体验、可访问性、一致性、文案、非关键状态 | 是否影响理解/效率但不影响正确性？ | 挂账打磨批，须有台账编号 |
| P3 | 建议、观察项、非阻断改进 | 是否只是更好而非必须？ | 记录，不阻塞 |

### 7.2 判定例

- **P0**：M116-QA-001 用户级授权「显示成功但不生效」，且移除时撤销整个项目凭证；U3 `out/web` 未构建时静态请求 0 字节挂起；U16 B 线旅程发现 Orca Web 云会话 handoff 后只有空态，没有终端/文件树入口（功能对等缺口）；U41 平台公网口无 TLS 导致 Mixed Content 全拦截；U49 bundle chunk 静态引入覆盖 `#root`，cloud-admin 打不开；U37 repo-ful 项目 provisioning 死锁。
- **P1**：M116-QA-002 审计硬编码 50 条无分页；QA-005 主机状态忽略心跳；QA-009 保存失败零提示；QA-011 加载失败永久「加载中」；QA-012 空提交触发锁定；API H14 错误类型污染全局状态；API G9 非法权限静默清空既有授权；U48 保存缺少执行宿主参数导致真宿主拒绝。
- **P2**：M116-QA-016 弹层 Esc/焦点/aria 缺陷；QA-019 时间格式 en-US；QA-024「最近项目」取最旧三个；QA-025 无脏数据也保存；U52 的 7 条打磨项。
- **P3/观察**：API A4 账号已锁定时返回 423 而非 401；H7 空 name 被接受；H44 非法 `protocolVersion` 存 `null`；U45 覆盖矩阵 3 格 PARTIAL（非缺口）。

### 7.3 分级流程与「非缺陷」

1. 先问「是否阻断主链路/是否丢数据/是否越权」→ P0。
2. 再问「是否有错误状态或误导，且用户需要绕行」→ P1。
3. 再问「是否正确，只影响体验/一致性」→ P2。
4. 最后问「是否只是建议」→ P3。
5. 设计如此、环境导致、测试脚本自身问题 → 标记「非缺陷/脚本缺陷」，写清依据，不塞进产品缺陷台账（U12、U45 的处理方式）。

**判定标准**：同一现象在不同身份/不同数据下级别可以不同，但必须写出理由；不允许为了「看起来轻」而降级，也不允许把脚本问题记成产品 P0。

---

## 8. 发现流转：从现场到回归的闭环

### 8.1 闭环图

```text
路径清单（入库）
    │ 执行
    ▼
findings.json（evidence，留盘）
    │ 去重、复现、分级
    ▼
defect-ledger 登记 U#（未修/在途/已修复）
    │ 复杂问题先出设计，再派实现
    ▼
修复提交 + 回归证据（evidence/<fix>/）
    │ 独立复验（测试/审计代理）
    ▼
台账置「已修复并回归」
    │ 追加
    ▼
路径清单新增回归用例（同脚本 regression 模式 / spec）
    │ 下轮重放
    └──────────────► 回到路径清单
```

### 8.2 执行规则

1. **先登记再派修**：一切测试/审计/诊断发现先进 `defect-ledger.md`，含编号、现象、根因、处置、回归证据位置；P2 也必须有编号，不允许只留在 PROGRESS 叙述里。
2. **用户报告不降级**：用户报告的问题在修复回归绿之前保持未修/在途；给用户的操作指引必须先实测。
3. **修复带用户精确场景**：如 U6 的准入修复用用户原始失败场景回归；U37 用「创建 repo-ful 项目→指派→克隆→回报→ready→取票→打开」全程无人工。
4. **修复即加用例**：新增断言进入回归脚本，并把对应路径追加进路径清单；不重写历史路径。
5. **独立复验**：实现代理、测试代理、审计代理三权分立；批量验收对当时 HEAD 跑全链，红项批量进修复队列。
6. **不静默放过**：测试适配导致的红也要登记（U34），不能改断言了事。

### 8.3 真实流转例

| 发现 | 登记 | 处置 | 回归/追加 |
| --- | --- | --- | --- |
| M116 用户级授权不生效且误撤会话 | QA-001 → W2-F1 | 修匹配与撤销路径 | `web-exploratory-fixes` 系列回归 |
| M116 三个管理功能缺口 | QA-013/014/015 → M120 | 登记弹层、权限矩阵、项目级策略 | 三个新 e2e 套件 + 变异抽查 |
| U46-8 真栈旅程红项 | U48/U49/U50 | 保存绑定、chunk 解耦、commit diff 身份 | E4 真栈转绿 + 构建图门禁 |
| U46 批审计 2 major | U51 | 脏标签三选确认、ready 失败态重试 | 188+6+25 用例 |
| W12b-1 探针 5/6 红 | U23/U24 | 已存在 git 目录登记、并发 created 标志 | 平台级终证探针 + 新套件 |
| U34 适配暴露 repo-ful 死锁 | U37 | 心跳指派 + 宿主执行器 + 端到端 | 3 轮端到端绿 + M57 复活 |
| 中继注册实证发现 env 名不一致/路由空/空体 | U38/U39/U43 | 双名兼容、心跳补路由、mtls 补写体 | 真实中继终验三连 |

### 8.4 判定标准

- 台账中每条「已修复」都有回归证据路径；没有证据的「已修复」不成立。
- 路径清单的用例数只增不减；删除/改写必须说明原因。
- 下一轮探索开始时，先按上一轮路径清单重放一遍，再扩展到新边界。

---

## 9. 工具形态

### 9.1 Playwright Server：常驻探索 + 独立回归

据 `work-orders/playwright-server-design.md`：

- 独立 Node 进程，持有一个 headless Chromium；每个身份一个 `BrowserContext`（admin/zhangsan/lisi），`storageState` 落盘，服务重启后仍登录。
- 默认 `127.0.0.1:0` 随机端口；启动写 `evidence/playwright-server/server.json`（0600，含 port/token/pid）；仅回环，Bearer token + Host/Origin 校验。
- `TabRegistry` 管理 `t1,t2,…`，按 id/URL/标题/`active` 寻址；记录页签所属身份与 iframe。
- HTTP 控制面：`/tabs`、`/tabs/:id/state|screenshot|evaluate`、`/profiles/:name/login`、`/scripts`、`/runs`、`/prototype/inventory`、`/compare/prototype`；WS 推送 `run.started/step/log/screenshot/run.result`。
- 单文件脚本两模式共用：`POST /runs {mode:"explore"}` 注入常驻 `ui/page`；`node journey.mjs` 由 `runIfMain` 启动临时 Chromium，执行同一个 `run`。
- 原型对照：同一 DOM 清点器双轮（prototype.html `file://` + 实际页，admin/developer 两轮），输出 `diff.json` + `report.md` + 并排截图。
- **落地状态**：Playwright Server 已落地（PS-1 核心、PS-2 扩展函数、PS-3 原型对照、PS-4 示例/文档），入口 `cloud-platform/scripts/playwright-server/README.md`。

### 9.2 当前可用的探索入口

| 入口 | 文件 | 用途 |
| --- | --- | --- |
| API 探索 | `scripts/exploratory-r2/run-api-exploratory.mjs` | 13 个 area、251 case；可逆清理；输出 api.json/api-raw.json |
| 同页工作区 | `scripts/exploratory-r2/run-workspace-exploration.mjs` | A–O 15 段；overlay/文件树/编辑器/预览/Git/终端/跨主机/快速打开/登出 |
| 工作区冒烟 | `scripts/exploratory-r2/probe-workspace.mjs` | 轻量探针 |
| Electron 桌面 | `desktop-harness.mjs` + `driver-*.mjs` | 登录、激活、终端、菜单、行 DOM、运行时 RPC |
| 本地数据面 | `local-env-reseed.mjs` | 幂等重建平台、双主机、项目、授权、中继 |

### 9.3 Electron 探索的硬约束

- `ORCA_BACKGROUND_LAUNCH=1`、`ORCA_E2E_HEADLESS=1`、隔离 HOME/userData。
- 不 `show()`、不 `showInactive()`、不 `bringToFront()`、不 `app.focus()`、不做 OS 激活。
- 截图通过隐藏 renderer 的 CDP；需要用户桌面焦点/可见窗口的测试一律暂停，放到隔离显示或 CI。
- 修改过启动策略代码先重建，再运行。

### 9.4 仪器化 oracle 的先例与边界

`src/renderer/src/components/editor/monaco-e2e-probe.ts` 仅在 `--mode e2e` 或 `VITE_EXPOSE_STORE=true` 时安装 `window.__monacoEditorE2E`，生产构建不暴露。

原则：

1. 优先真实 DOM / `data-testid` / role / 文本；仪器化只用于 UI 无法暴露的内部状态。
2. 仪器化必须有生产关闭门；不得把测试专用分支带进产品行为。
3. 新增仪器化前先检查既有 oracle 是否已够用（`VITE_EXPOSE_STORE`、`__monacoEditorE2E`）。
4. 共享产物 `out/web` 对构建 env 敏感（U36）：重建时必须带正确 flag，否则 store/编辑器 oracle 被折叠为 false，旅程会静默变红。

### 9.5 判定标准

- 探索代理能连续注入多个脚本，浏览器不重启、登录态不丢、页签可复用。
- 同一个脚本在 server 注入模式与 `node` 独立模式结果一致；改坏断言时独立模式退出 1 并指出 step。
- 工具不写产品代码目录；server 目录 import 只允许 `node:*`、`playwright`、`playwright-core`、`ws`。

---

## 9a. 组合探索方法（2026-11-15 用户指令：多主机/多项目/多用户授权组合）

资源面允许多主机/多项目/多用户时，探索从「单点功能」升级为**组合矩阵**：
- **三维组合**：主机 × 项目 × 用户——同主体跨主机不同位、同主体跨项目不同位、同组不同用户不同位（三维差异化矩阵）。
- **授权一致性双向核对**：每个授权组合变更后，立即以该身份实测实际能力（可见/打开/终端/编辑/下载/自助建项目），并与 connect 票据 perms、GET 授权行**逐位对照**——三者不一致即 finding（能力↔票据↔授权行）。
- **策略联动**：provisionPolicy open/restricted 切换 × 各主机授权差异 × 在途操作影响（如 restricted 后已授权成员仍可建、未授权 403、admin 例外）。
- **状态可逆**：授权/策略变更用后还原 seed 态；探针项目/宿主用后归档/吊销；避免污染其他探索路共享的平台实例。
- **复用**：路径清单追加（`authz-combo-paths.md` 形态）+ Playwright Server 扩展函数（login 身份切换/openWorkspace/extractState）直接支撑组合重放。

## 9b. 文字提取优先原则（2026-11-15 用户指令补充）

探索中**优先提取页面文字**（locator.innerText/textContent 结构化提取，按区域批量拉取），快速识别重点区域的数据与状态是否符合预期——**效率优于截图视觉识别**：文本可精确比对（预期值/状态词/计数/空态文案）、可直接入 findings JSON、无需人工看图。

操作要点：
- 重点区域先取整块文本再判读（如工作台项目卡/详情弹框 .kv 区/状态徽标/审计行/主机行），而非逐元素截图。
- 状态词比对：「就绪/准备中/失败/离线/维护/已吊销」等业务状态直接在提取文本中断言。
- 截图仅作辅助证据（布局类问题、视觉回归），不承担数据/状态正确性判断。
- Playwright Server 包装层的 `assertText/discover` 即按此原则设计；`page.innerText(selector)` 支持整块提取。

## 9c. 红因定性方法论（2026-11-15 复盘固化）
- **构建对照纪律（2026-11-16 04:05 复盘固化，U75 假红判例）**：A/B 对照构建只许差被测变量（未提交 WIP、构建 flag 二者必控）；构建产物须自校验关键 marker（如 VITE_EXPOSE_STORE 死代码探测，与 verify-web-build 门禁并跑）——「双构建同红」在对照不纯时无效，U75 即因此把 oracle 缺陷误判为 HEAD 回归。
- **bisect 提效（2026-11-16 复盘固化）**：多候选回归先做「diff 审读+符号定位」缩小到 1-2 候选，构建复放只做终确认——快照独立 out/ 全构建×N 候选耗时不可接受（U75 判例）。
