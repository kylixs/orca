# W10 审计报告（客户端零 env 登录记忆地址/用户名）

- 审计人：独立审计代理（只读，恢复轮）
- 日期：2026-11-14
- 审计对象：提交 `af75dc475ea`（feat(cloud): remember platform address and username from login，29 文件 +1366/−48）
- 对照基准：`work-orders-2026-11-14.md` §W10 定稿节、`requirements.md` FR-2.7、AGENTS.md（复用/命名/注释/跨平台/远程线兼容/max-lines 纪律）
- 方法：只读 diff 逐文件审阅 + 源码交叉验证 + 构建配置运行时内省（`electronViteConfig`）+ 模块级探针（`tsx`）+ 定向测试复跑（52 用例）。审计期间未修改任何源文件，仅新增本报告。
- 说明：`cloud-session-service.ts` 行数按 oxlint `max-lines` 实际口径（`skipBlankLines:true, skipComments:true`）统计；仓库 `oxfmt` 为格式化器，非 prettier。

## 结论

**有条件通过**：blocker 1、major 2、minor 5、note 6。

主体语义与安全边界大体成立：地址优先级 env > 记忆 > 构建默认 > 空与 FR-2.7 一致且逐档降级不抛错；非法**手填地址**被拒绝而非静默换平台；记忆文件沿用 M66 受保护文件写法且不含会话令牌；bridge 三参/新通道对旧调用方零破坏；`cloud-session-service.ts` 按实际 lint 口径 298 行（≤300）合规、无 max-lines 禁用。**但存在一个阻断项**：`define` 只挂在 `main` 构建，preload 未注入两个新常量，导致「构建期注入默认地址 / 仅托管开关、无运行时 env」的企业安装包在 preload 判定为非云端构建，`window.api.cloud` 不暴露、登录界面根本不出现——恰是 W10 的主场景。另有两项 major：托管锁定可被本地记忆覆盖；手填地址中的 `user:pass@` 会被原样写入登录记忆文件。

---

## 1. 安全（审计点①）

### 1.1 记忆文件内容边界

`writeCloudLoginMemory`（`src/main/cloud-platform/cloud-login-memory.ts:52-67`）写入的 payload 仅有 `{ version, cloud: { lastPlatformUrl, lastUsername }, savedAtMs }`，无 token、refreshToken、deviceSecretKey；文件走 `writeSecureJsonFile` + `hardenExistingSecureFile`（与 `cloud-session-persistence.ts:79-86` 同款惯例），测试断言 POSIX `mode & 0o077 === 0`。**正常路径下无密码/令牌。**

但「绝无密码」存在一个绕过面（→ **M2**）：平台地址经 `cleanCloudServiceUrl` 清洗，而该函数用 `new URL(...).toString()` 保留 URL userinfo。实测 `https://user:secret@cloud.example.com` 会被原样接受并最终由 `attach` 写入 `lastPlatformUrl`。因此用户（或被诱导粘贴）带凭据的地址会把密码落进记忆文件。

`readCloudLoginMemory` 对缺失字段/坏 JSON 返回空记忆且不删原文件；读出的地址还会再次经过 `resolveCloudPlatformAddress` 清洗，损坏值不会直接使用。

### 1.2 托管锁定与 `loginPlatformAddress` 地址门

逐项核验地址门（`src/main/cloud-platform/cloud-platform-address.ts:62-84`）：

| 输入 | 结果 | 判定 |
|---|---|---|
| 托管已锁定 + 任意表单值 | 返回锁定地址，忽略输入 | ✓ |
| 非托管 + 合法手填 | 使用手填，去尾斜杠 | ✓ |
| 非托管 + 非法手填（`ftp://`、非 URL） | `PLATFORM_ADDRESS_INVALID`，不静默换平台 | ✓ |
| 大小写 scheme/host | `new URL` 归一化为小写，通过 | ✓ |
| 前后空格 | `trim()` 后清洗 | ✓ |
| 尾斜杠 / 双斜杠 | `replace(/\/$/,'')` 归一 | ✓ |
| IPv6 | `[::1]` 环回识别正确 | ✓ |
| 非 http(s) | 拒绝 | ✓ |
| 打包构建 http 非环回 | 主进程拒绝 | ✓ |

未发现「非法手填地址静默换平台」。但注意两处：

- **M1（托管锁定可被记忆覆盖）**：`resolveCloudPlatformAddress` 的档位对托管构建同样按 env > **记忆** > 构建默认解析，`locked` 只是对**已解析结果**加锁。实测 `managed=true, build=ignored` 且记忆为 `https://remembered-evil.example.com` 时，结果为 `{ apiUrl: remembered, source:'memory', locked:true }`，构建期锁定地址被忽略。企业把普通安装升级为托管包、或本地残留上一次平台记录时，托管客户端会锁到他处。W10 测试未覆盖「托管 + 记忆」组合。
- 托管构建**无任何可解析地址**时 `locked=false`（代码注释明确为「不死锁登录」），允许用户手填任意平台。这是有意取舍，但与「托管锁定地址语义不变」存在解释空间；作为 note 记录。

### 1.3 其他

- 记忆文件在登出后保留（设计要求），共用同一 OS 账号的下一位用户会看到上一位的平台地址与域账号预填；文件 0600，跨 OS 账号不可读。属已接受风险（→ note）。
- `getLoginContext` 在未登录时即返回记忆中的用户名/地址，符合预填需求，不构成认证绕过。

---

## 2. 语义（审计点②）

- **优先级**：`resolveCloudPlatformAddress` 档位顺序为 `env → memory → build → none`，与 FR-2.7「上次成功登录 > 构建注入 > 空；环境变量仅作预填/覆盖」及 W10 #2 一致。手填地址在非托管下优先于 env（覆盖语义），托管下被忽略（锁定语义），与文档一致。
- **逐档降级**：非法 env/记忆跳过到下一档，不抛错；空档返回 `source:'none'`，登录时由 `beginLogin` 抛 `PLATFORM_ADDRESS_REQUIRED`，不会对空地址发请求。测试覆盖。
- **非云端构建零回归断言**：**行为级断言真实存在**——`cloud-platform-login-gate.test.ts:121-125`（`installCloudPlatformIpc({})` 返回 null、零 handler）、`cloud-platform-exposure.test.ts:41-44`（无 `cloud` 成员）、既有 `App.cloud-mode-regression.test.tsx`（无 bridge 渲染原生 shell）。但**不存在「逐字节不变」断言**，且由于新增模块被打进 main/preload，字面逐字节不变也不成立；仓库也没有针对新常量的打包产物校验（`verify-telemetry-constants.mjs` 只覆盖遥测常量且只扫 main）。→ **m1**。
- **登出保留记忆**：符合 W10 明确要求（记忆与会话分离，登出只删会话），风险评估见 note。

---

## 3. 线兼容与构建产物（审计点③）

- **bridge 第三参**：`CloudPlatformApi.login(username, password, platformUrl?)`、IPC handler 第三参可选；旧两参调用方（旧 preload / 既有 fixture）行为不变，`registerCloudPlatformHandlers` 在未提供 `loginAddress` 时直接透传。✓
- **新通道** `cloud:loginContext`：仅新增，未改既有 opcode；preload+renderer+main 同包发布，不涉及远程线协议。`CloudBridge` 的所有实现（preload、`createCloudBrowserBridge` 及全部测试桩）均已补 `getLoginContext`。✓
- **vite define 折叠**：
  - **Blocker B1**：`define` 仅位于 `main` 配置块（`electron.vite.config.ts:313`），`preload` 配置块（`:332`）没有 define。运行时内省确认：
    ```
    main.define?    true  { ..., ORCA_DEFAULT_PLATFORM_URL: "\"https://baked.example.com\"", ORCA_MANAGED_BUILD: "true" }
    preload.define? false undefined
    renderer.define? false undefined
    ```
    electron-vite 5 的 `resolveConfig` 分别 `mergeConfig(config.main, inline)` 与 `mergeConfig(config.preload, inline)`，不会把 main 的 define 提升到 preload（`node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:1532-1587`）。preload 的 `src/shared/cloud-build-flags.ts` 因此保留 `typeof ORCA_DEFAULT_PLATFORM_URL` 自由标识符，运行时恒为 `'undefined'` → `builtInDefaultPlatformUrl()` 返回 null、`isManagedOrcaBuild()` 返回 false。结果：仅靠构建期默认地址或仅托管开关（无运行时 env）的安装包，main 注册了 handler，preload 却不暴露 `window.api.cloud`（`src/preload/cloud-platform-exposure.ts:12-14`），`CloudWorkspaceEntry` 走 `!bridge` 分支直接渲染原生 shell（`cloud-workspace-entry.tsx:325-330`），登录界面不出现。**W10 的零 env 主场景失效。**
  - 现有测试用 `stubCloudBuildFlagsForTests` 直接注入常量，绕过了真实打包替换，因此测试全绿反而掩盖该缺口。
  - 折叠本身正确：非云端构建主进程常量 fold 为 `null`/`false`，`typeof null === 'object'` 仍进入返回分支并返回 null，行为不变。`build-constants.d.ts:16-23` 注释称两常量「main and preload」均读取，与事实不符（见 note）。

---

## 4. 规范（审计点④）

- **max-lines**：`src/main/cloud-platform/cloud-session-service.ts` 当前 raw 364 行，按 oxlint 口径（去空行/整行注释）**298 行**；`pnpm exec oxlint` 对该文件及同目录退出码 0，`config/max-lines-baseline.txt` 无该文件，无任何 `max-lines` 禁用。父提交同为 counted 298。**按实际门禁合规**，但仅剩 2 行余量，脆弱。任务提到的「317 行超限」与实测不符（父 raw 357、counted 298），建议明确以 lint 口径为准（→ note）。
- **triple-slash**：提交内 `///` 命中 0；`build-constants.d.ts` 使用普通 `declare const`。无整改遗留。✓
- **命名**：`cloud-build-flags.ts` / `cloud-platform-address.ts` / `cloud-login-memory.ts` 均为具体领域名，无 `helpers/utils/common`。✓
- **注释密度**：模块头与导出符号均有 JSDoc，另有大量 `Why:` 内联；密度偏高但基本在解释非显而易见的构建/持久化语义，未见过程复述。可接受（→ note）。
- **类型**：`login()` 删除了显式 `Promise<CloudSessionState>` 返回类型（`cloud-session-service.ts:154`），与同类其余方法风格不一致（→ note）。
- **复用**：记忆持久化复用 `secure-file` 与 `json-fields`，未另造轮子。✓

---

## 5. diff 归属与全仓 format 噪声（审计点⑤）

**本提交内无任何无关格式化改动。**

- 对 29 文件逐 hunk 做 token 级比对（去空白/尾逗号/括号差异），未发现「删除集 == 新增集」的纯格式化 hunk；`git diff -w` 与普通 diff 的 numstat 完全一致，排除纯空白改动。
- 29 文件全部落在 W10 客户端域：8 个新增源/测试（地址解析、登录记忆、构建开关、IPC 门、登录面板及各测试），21 个修改均为 W10 语义所必需（props/类型/工厂签名/测试桩补 `getLoginContext`）。没有云端文档、平台侧或无关模块被夹带。
- 该代理 `pnpm format`（仓库脚本为 `oxfmt --write .`）的残留**仍在未提交工作区**：当前 `git diff` 约 141 文件（含 `remote-connectivity/**` 文档/HTML、`cloud-platform/apps/**` 及在途 W5a 的 renderer 改动），与本提交无关，也未进入本提交。
- 结论：**混入本提交的无关格式化改动清单为空**。

---

## 6. 分级发现清单

### Blocker（1）

- **B-1 preload 未注入构建常量，零 env 构建注入/托管构建不出现登录界面**
  - 位置：`electron.vite.config.ts:313`（define 仅在 main）、`:332`（preload 无 define）；`src/preload/cloud-platform-exposure.ts:12-14`；`src/shared/cloud-build-flags.ts:61`。
  - 现象：`ORCA_DEFAULT_PLATFORM_URL` 或仅 `ORCA_MANAGED_BUILD=1`、无运行时 env 的安装包，preload 判定 `isCloudPlatformBuild=false`，`window.api.cloud` 缺失，`CloudWorkspaceEntry` 渲染原生 shell，无登录表单。main 侧 handler 已注册但无调用方。
  - 影响：W10 主验收场景（企业构建期预填、安装即用）失效；现有测试因 stub 常量而全绿。
  - 建议：把同一 `define` 块复制到 `preload` 配置（renderer 不需要），并补一条构建产物级断言（例如 preload 产物中必须出现折叠后的常量字面量，而非 `typeof ORCA_DEFAULT_PLATFORM_URL`）；同时修正 `build-constants.d.ts` 的注释。

### Major（2）

- **M-1 托管锁定的地址可被本地登录记忆覆盖**
  - 位置：`cloud-platform-address.ts:27-55`（档位 env>memory>build）+ `:69`（对解析结果加锁）；`ipc/cloud-platform.ts:262`（无条件读记忆）、`:284`（快照 loginContext）。
  - 复现：`stubCloudBuildFlagsForTests({ managed:true, defaultUrl:'https://pinned.example.com' })` + 记忆 `https://remembered-evil.example.com` → `{ apiUrl:'https://remembered-evil.example.com', locked:true }`。
  - 影响：企业把既有安装升级为托管包、或本地残留他平台记录时，托管客户端锁定到错误平台；与「托管构建锁定地址语义不变」冲突。
  - 建议：托管构建只解析 env > build（忽略/拒绝记忆），或记忆档仅在非托管生效；补「托管 + 非空记忆」用例。

- **M-2 手填地址中的 URL 凭据会被写入登录记忆文件**
  - 位置：`cloud-platform-address.ts:80`（`cleanCloudServiceUrl` 保留 userinfo）；`cloud-session-saved-login.ts:57-68, 80-86`（写入 `this.options.apiUrl`）。
  - 复现：`loginPlatformAddress(resolved, 'https://user:secret@cloud.example.com', true)` → `{ ok:true, apiUrl:'https://user:secret@cloud.example.com' }`，成功登录后该串落入 `lastPlatformUrl`。
  - 影响：违反「记忆文件绝无密码/令牌」的显式边界；同时接受 path/query/hash，平台地址语义被放宽。
  - 建议：`loginPlatformAddress` 与 `cleanCloudServiceUrl` 增加 `parsed.username === '' && parsed.password === ''`（并建议 origin-only / 拒绝 search+hash）校验；补负向用例。

### Minor（5）

- **m-1 「非云端构建逐字节不变」没有对应断言**
  - 仅有行为级断言（install 返回 null、preload 无 cloud、renderer 原生 shell）；不存在产物字节比对，仓库也没有新常量的打包校验。建议把措辞改为「行为零回归」，并为 preload 常量折叠补产物级断言（与 B-1 同修）。
- **m-2 同一进程内登出后预填不更新**
  - `use-cloud-session.ts:167` 仅在挂载时取一次 `getLoginContext`，且 main 的 `loginContext` 是安装时快照（`ipc/cloud-platform.ts:284`）。用户改地址登录后再登出，登录表单仍预填启动时的旧地址/用户名，直到下次启动才正确。工作令只要求「下次启动」，故为 minor；建议登出/登录成功后刷新一次。
- **m-3 新错误码在 IPC 边界丢失，UI 可能显示未映射文案**
  - `ipc/cloud-platform.ts:82` 抛 `new Error('platform address rejected')` 携带 `code`；Electron 文档明确 renderer 收到的 Error「不会是主进程抛出的那个」，自定义属性不保留。既有登录错误以 `new Error(code)` 让 message 充当 code（`cloud-connect-client.ts:186`），新错误没有沿用。当 renderer 内联校验放过、main 拒绝时（如打包构建的 `http://` 非环回），用户会看到 `登录失败（Error invoking remote method … platform address rejected）`。建议 message 直接用错误码。
- **m-4 renderer 内联校验与主进程规则分叉**
  - `cloud-login-panel.tsx:43-58` 只校验 http(s)，接受任意主机 `http://` 与带 userinfo 的 URL；main 在打包构建拒绝非环回 http。两套规则易漂移，且放大了 m-3 的可见性。建议抽共享判定或让内联校验镜像主进程（至少拒绝 userinfo）。
- **m-5 `beginLogin` 在登录成功前就改写共享 `apiUrl`**
  - `cloud-session-saved-login.ts:57-68` 先 `this.options.apiUrl = typed` 再发请求；登录失败（如密码错）后会话仍被重指向失败地址，后续同进程内的恢复/落盘使用该地址。建议成功后再提交，或失败回滚。补断言。

### Note（6）

- **n-1 max-lines 合规口径**：raw 364 / counted 298（≤300），oxlint 通过、不在 baseline、无禁用；余量仅 2 行，后续改动需拆分而非加行。任务所述「此前 317 行」与实测（父 raw 357 / counted 298）不符，建议以 lint 口径记录。
- **n-2 登出保留记忆的共用机器风险**：同 OS 账号下会泄露上一位用户的平台地址与域账号（无凭据、仍需密码）。属明确设计要求；如需共用机策略，建议增加「清除登录记忆」入口或按策略在登出时清理。
- **n-3 注释与命名**：命名合规、无 triple-slash；注释密度偏高但均为非显而易见的构建/持久化 Why，可接受。
- **n-4 声明重复与注释失真**：`cloud-build-flags.ts:12-13` 的模块级 `declare const` 与 `build-constants.d.ts:22-23` 全局声明重复；后者称常量在 main 与 preload 均被替换，实际 preload 未替换（与 B-1 同源）。
- **n-5 生产代码中的测试开关**：`stubCloudBuildFlagsForTests` 可运行时翻转托管开关，仅进程内可用、无外部入口；建议将其隔离到测试构建或加注释说明。
- **n-6 半损坏记忆整条丢弃**：`cloud-login-memory.ts:21-33` 只要地址或用户名任一缺失即返回空记忆，地址也一并丢失；按注释为「丢失预填不算错误」的取舍，可接受。
- **n-7 显式返回类型**：`CloudSessionService.login` 去掉 `Promise<CloudSessionState>`，与同类方法风格不一致（style note）。

---

## 7. 复核证据

- 定向测试复跑：`cloud-platform-address` / `cloud-login-memory` / `cloud-session-login-address` / `cloud-platform-login-gate` → 4 文件 28 用例全过；`cloud-login-panel` / `use-cloud-session` / `cloud-platform-exposure` → 3 文件 24 用例全过（合计 52）。
- `pnpm exec oxlint`（8 个改动源文件及 `src/main/cloud-platform` 目录）退出码 0。
- 构建配置运行时内省：`main.define` 含两常量，`preload.define` / `renderer.define` 为 undefined。
- 模块探针：托管+记忆解析、userinfo 地址接受、renderer 内联校验接受 `http://` 非环回，均已复现并记录于上文。
- 全仓 format 噪声未进入本提交；当前未提交 `git diff` 约 141 文件，归属其他在途任务与 format 残留。
