# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: cloud-golden-journey-desktop.spec.ts >> W9a 桌面黄金旅程：登录 → 打开项目（直连）→ 终端 → 文件树
- Location: tests/e2e/cloud-golden-journey-desktop.spec.ts:419:5

# Error details

```
Error: the client never activated the per-user checkout of the project

the client never activated the per-user checkout of the project

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false

Call Log:
- Timeout 180000ms exceeded while waiting on the predicate; client store: {"repos":[],"worktreeKeys":[]}
```

# Page snapshot

```yaml
- generic [ref=f1e3]:
  - generic [ref=f1e4]:
    - generic [ref=f1e6]:
      - generic [ref=f1e7]:
        - generic [ref=f1e9]:
          - generic [ref=f1e10]:
            - generic "Orca" [ref=f1e11] [cursor=pointer]
            - button "切换侧边栏" [ref=f1e13] [cursor=pointer]
          - generic [ref=f1e16]:
            - button "返回" [disabled] [ref=f1e17]
            - button "前进" [disabled] [ref=f1e20]
        - generic [ref=f1e24]:
          - generic [ref=f1e25]:
            - button "搜索工作树和浏览器选项卡" [ref=f1e26] [cursor=pointer]:
              - generic [ref=f1e30]: 搜索
            - button "8 设置步骤中的 2 已完成 入门清单" [ref=f1e31] [cursor=pointer]:
              - generic "8 设置步骤中的 2 已完成" [ref=f1e32]
              - generic [ref=f1e36]: 入门清单
            - generic [ref=f1e38]:
              - button "任务" [ref=f1e39] [cursor=pointer]
              - generic:
                - button "打开 GitHub 任务"
                - button "打开 Jira 任务"
            - button "自动化" [ref=f1e42] [cursor=pointer]
            - button "Orca 手机端 新功能" [ref=f1e49] [cursor=pointer]:
              - generic [ref=f1e52]: Orca 手机端
              - generic [ref=f1e53]: 新功能
          - generic [ref=f1e54]:
            - generic [ref=f1e55]: 项目
            - generic [ref=f1e57]:
              - button "查看活动" [ref=f1e59] [cursor=pointer]
              - generic [ref=f1e60]:
                - button "工作区选项" [ref=f1e61] [cursor=pointer]
                - button "添加项目" [ref=f1e62] [cursor=pointer]
                - button "新工作区" [ref=f1e63] [cursor=pointer]
          - listbox "工作树" [ref=f1e65]:
            - button "journey-payment journey-payment 的项目操作 为 journey-payment 创建新工作树" [expanded] [ref=f1e66] [cursor=pointer]:
              - generic [ref=f1e67]: journey-payment
              - generic:
                - button "journey-payment 的项目操作"
                - button "为 journey-payment 创建新工作树"
            - option "Mark as unread Inactive main 主要 main" [ref=f1e75]:
              - generic [ref=f1e76]:
                - generic [ref=f1e78] [cursor=pointer]:
                  - generic [ref=f1e79]:
                    - button "Mark as unread" [ref=f1e80]
                    - generic [ref=f1e86]: Inactive
                  - generic [ref=f1e88]:
                    - generic [ref=f1e90]:
                      - generic [ref=f1e91]: main
                      - generic [ref=f1e92]: 主要
                    - generic [ref=f1e93]: main
                - button [aria-hidden]
            - option "Mark as unread Active main e2e/main" [ref=f1e96]:
              - generic [ref=f1e97]:
                - generic [ref=f1e99] [cursor=pointer]:
                  - generic [ref=f1e100]:
                    - button "Mark as unread" [ref=f1e101]
                    - generic [ref=f1e107]: Active
                  - generic [ref=f1e109]:
                    - generic [ref=f1e110]: main
                    - generic [ref=f1e113]: e2e/main
                - button [aria-hidden]
          - generic [ref=f1e118]:
            - generic [ref=f1e120]:
              - button "设置" [ref=f1e121] [cursor=pointer]
              - button "帮助" [ref=f1e122] [cursor=pointer]
            - generic [ref=f1e123]:
              - button "显示活动工作区" [ref=f1e124] [cursor=pointer]
              - button "工作区板" [ref=f1e125] [cursor=pointer]
      - generic [ref=f1e130]:
        - generic [ref=f1e134]:
          - img "Orca 标志" [ref=f1e136]
          - heading "ORCA" [level=1] [ref=f1e137]
          - paragraph [ref=f1e138]: 从侧边栏中选择一个工作区开始。
          - generic [ref=f1e139]:
            - button "添加项目" [ref=f1e140] [cursor=pointer]
            - button "创建 worktree" [ref=f1e143] [cursor=pointer]
          - generic [ref=f1e148]:
            - generic [ref=f1e149]:
              - generic [ref=f1e150]: Create worktree
              - generic [ref=f1e151]:
                - generic [ref=f1e152]: ⌘
                - generic [ref=f1e153]: "N"
            - generic [ref=f1e154]:
              - generic [ref=f1e155]: Move up workspace
              - generic [ref=f1e156]:
                - generic [ref=f1e157]: ⌘
                - generic [ref=f1e158]: ⇧
                - generic [ref=f1e159]: ↑
            - generic [ref=f1e160]:
              - generic [ref=f1e161]: Move down workspace
              - generic [ref=f1e162]:
                - generic [ref=f1e163]: ⌘
                - generic [ref=f1e164]: ⇧
                - generic [ref=f1e165]: ↓
        - button "显示浮动工作区" [ref=f1e167]
        - button [aria-hidden]
    - generic [ref=f1e169]:
      - generic [ref=f1e170]:
        - generic [ref=f1e173]:
          - button "Explorer (⌘⇧E)" [ref=f1e174] [cursor=pointer]
          - button "Agents" [ref=f1e180] [cursor=pointer]
          - button "Source Control (⌘⇧G)" [ref=f1e187] [cursor=pointer]
          - button "Checks" [ref=f1e192] [cursor=pointer]
        - button "Toggle right sidebar" [ref=f1e197] [cursor=pointer]
      - generic [ref=f1e200]: 选择一个工作区来浏览文件
  - generic [ref=f1e204]:
    - button "刷新速率限制" [ref=f1e207] [cursor=pointer]
    - generic [ref=f1e214]:
      - button "防止电脑休眠，关闭 · 未生效" [ref=f1e215] [cursor=pointer]:
        - generic [ref=f1e218]: 关闭
      - button "资源管理器，1 个终端会话" [ref=f1e220] [cursor=pointer]:
        - generic [ref=f1e223]: 683.2 MB
        - generic [ref=f1e224]: ·
        - generic [ref=f1e227]: "1"
      - button "端口，0 工作区 ports" [ref=f1e228] [cursor=pointer]:
        - generic [ref=f1e231]: "0"
      - button "登录云端平台" [ref=f1e232] [cursor=pointer]
    - button [aria-hidden]
  - dialog "Orca 入门引导" [ref=f1e235]:
    - generic [ref=f1e236]:
      - generic [ref=f1e237]: Orca
      - generic [ref=f1e240]:
        - button "前往入门步骤 1：默认智能体" [ref=f1e241] [cursor=pointer]
        - button "前往入门步骤 2：外观" [ref=f1e242] [cursor=pointer]
        - button "前往入门步骤 3：通知" [ref=f1e243] [cursor=pointer]
        - generic [ref=f1e244]: 1 / 3
      - generic [ref=f1e245]:
        - generic [ref=f1e246]: 欢迎使用 Orca
        - heading "选择默认智能体" [level=1] [ref=f1e247]
        - paragraph [ref=f1e248]: Orca 支持所有 CLI 智能体。选择你最常用的一个，随时可切换。
      - generic [ref=f1e250]:
        - generic [ref=f1e251]:
          - generic [ref=f1e252]:
            - generic [ref=f1e253]: 在系统中已检测
            - generic [ref=f1e254]: "7"
          - generic [ref=f1e256]:
            - generic [ref=f1e257]:
              - button "Claude" [pressed] [ref=f1e258] [cursor=pointer]
              - button "Claude Agent Teams" [ref=f1e266] [cursor=pointer]
              - button "Qoder CLI" [ref=f1e271] [cursor=pointer]
              - button "Gemini" [ref=f1e275] [cursor=pointer]
              - button "Kiro" [ref=f1e279] [cursor=pointer]
              - button "Continue" [ref=f1e283] [cursor=pointer]
              - button "CodeBuddy" [ref=f1e287] [cursor=pointer]:
                - img [aria-hidden] [ref=f1e289]:
                  - generic [ref=f1e291]: C
            - button "显示另外 38 个智能体 →" [ref=f1e294] [cursor=pointer]
        - generic [ref=f1e295]:
          - generic [ref=f1e296] [cursor=pointer]:
            - generic [ref=f1e297]: Yolo 模式
            - generic [ref=f1e298]: 智能体会在不询问的情况下运行命令和编辑文件，部分智能体还会绕过沙箱。仅在你信任的项目中使用。
          - switch "Yolo 模式 智能体会在不询问的情况下运行命令和编辑文件，部分智能体还会绕过沙箱。仅在你信任的项目中使用。" [checked] [ref=f1e299] [cursor=pointer]
      - contentinfo [ref=f1e300]:
        - button "跳至项目设置" [ref=f1e301] [cursor=pointer]
        - button "继续 ⌘" [ref=f1e303] [cursor=pointer]:
          - text: 继续
          - generic [ref=f1e304]: ⌘
  - region "Notifications alt+T"
```

# Test source

```ts
  401 |   }
  402 | })
  403 | 
  404 | test.afterAll(async () => {
  405 |   if (stack) {
  406 |     await closeElectronAppForE2E(stack.host).catch(() => undefined)
  407 |     await stack.platform.stop()
  408 |   }
  409 |   writeEvidence('journey-timeline.json', {
  410 |     line: 'A-desktop',
  411 |     workOrder: 'W9a',
  412 |     runMarker: RUN_MARKER,
  413 |     generatedAt: new Date().toISOString(),
  414 |     steps: timeline,
  415 |     screenshots: shots
  416 |   })
  417 | })
  418 | 
  419 | test('W9a 桌面黄金旅程：登录 → 打开项目（直连）→ 终端 → 文件树', async () => {
  420 |   test.setTimeout(600_000)
  421 |   expect(stack, 'stack must have started').toBeTruthy()
  422 |   const session = stack!
  423 | 
  424 |   // ── A2 · 开发者登录（W11：状态栏 segment → 弹框）───────────────────
  425 |   const entered = await journeyStep(
  426 |     'A2-login',
  427 |     '开发者登录（状态栏「登录云端平台」segment → 弹框，平台地址预填）',
  428 |     async () => {
  429 |       const client = await launchOrca(
  430 |         cloudClientEnv(session.platform.url),
  431 |         mkdtempSync(path.join(session.root, 'client-ud-')),
  432 |         { completedOnboarding: true }
  433 |       )
  434 |       const page = await client.firstWindow({ timeout: 120_000 })
  435 |       await page.waitForLoadState('domcontentloaded')
  436 |       // W11: the workspace shell lands first; the sign-in dialog hangs off the
  437 |       // status bar segment, and the address comes from the runtime login context.
  438 |       const shownAddress = await openCloudLoginDialog(page)
  439 |       expect(shownAddress, 'platform address must be prefilled from the runtime env').toBe(
  440 |         session.platform.url
  441 |       )
  442 |       await shoot(page, '01-login-dialog')
  443 |       await fillCloudLoginDialog(page, { username: DEVELOPER, password: PASSWORD })
  444 |       await submitCloudLoginDialog(page, { displayName: DEVELOPER_DISPLAY_NAME })
  445 |       await shoot(page, '02-signed-in')
  446 |       return { client, page }
  447 |     },
  448 |     () => ({
  449 |       platformUrl: session.platform.url,
  450 |       developer: DEVELOPER,
  451 |       entry: 'status-bar-segment-dialog'
  452 |     })
  453 |   )
  454 |   const { client, page } = entered
  455 | 
  456 |   try {
  457 |     // ── A3 · 打开项目（工作区 + 直连线路）────────────────────────────
  458 |     await journeyStep(
  459 |       'A3-open-project',
  460 |       '打开项目：工作区落在本人 checkout，线路为直连',
  461 |       async (): Promise<OpenedProject> => {
  462 |         // The entry registers every project as a repo, opens the first one and
  463 |         // activates the checkout it created; wait for the checkout itself, not
  464 |         // just for any worktree row.
  465 |         const checkoutActivated = (): Promise<boolean> =>
  466 |           page.evaluate(
  467 |             ({ projectPath, developer }) => {
  468 |               const state = window.__store?.getState()
  469 |               const activeWorktreeId = state?.activeWorktreeId ?? null
  470 |               const worktree = Object.values(state?.worktreesByRepo ?? {})
  471 |                 .flat()
  472 |                 .find((entry) => entry.id === activeWorktreeId)
  473 |               const path = typeof worktree?.path === 'string' ? worktree.path : null
  474 |               return Boolean(path?.includes(`${projectPath}/.orca-worktrees/${developer}`))
  475 |             },
  476 |             { projectPath: session.projectPath, developer: DEVELOPER }
  477 |           )
  478 |         try {
  479 |           await expect
  480 |             .poll(checkoutActivated, {
  481 |               timeout: CHECKOUT_TIMEOUT_MS,
  482 |               message: 'the client never activated the per-user checkout of the project'
  483 |             })
  484 |             .toBe(true)
  485 |         } catch (error) {
  486 |           // A red journey must hand over the store state that failed to
  487 |           // converge: that state is the integration finding.
  488 |           const clientState = await page
  489 |             .evaluate(() => {
  490 |               const state = window.__store?.getState()
  491 |               return {
  492 |                 repos: (state?.repos ?? []).map((repo) => ({
  493 |                   path: repo.path,
  494 |                   executionHostId: repo.executionHostId
  495 |                 })),
  496 |                 activeWorktreeId: state?.activeWorktreeId,
  497 |                 worktreeKeys: Object.keys(state?.worktreesByRepo ?? {})
  498 |               }
  499 |             })
  500 |             .catch(() => null)
> 501 |           throw new Error(
      |                 ^ Error: the client never activated the per-user checkout of the project
  502 |             `${error instanceof Error ? error.message : String(error)}; client store: ${JSON.stringify(clientState)}`
  503 |           )
  504 |         }
  505 |         const result = await page.evaluate(
  506 |           async ({ projectKey, projectPath }) => {
  507 |             type CloudBridge = {
  508 |               listProjects: () => Promise<Record<string, unknown>[]>
  509 |               openProject: (id: string) => Promise<Record<string, unknown>>
  510 |             }
  511 |             const bridge = (window as unknown as { api?: { cloud?: CloudBridge } }).api?.cloud
  512 |             if (!bridge) {
  513 |               throw new Error('cloud bridge missing on the client')
  514 |             }
  515 |             const projects = await bridge.listProjects()
  516 |             const project = projects.find((entry) => entry.key === projectKey)
  517 |             if (!project) {
  518 |               throw new Error(`project ${projectKey} not in the signed-in project list`)
  519 |             }
  520 |             const state = window.__store?.getState()
  521 |             const repo = (state?.repos ?? []).find((entry) => entry.path === projectPath)
  522 |             const activeWorktreeId = state?.activeWorktreeId ?? null
  523 |             const worktree = Object.values(state?.worktreesByRepo ?? {})
  524 |               .flat()
  525 |               .find((entry) => entry.id === activeWorktreeId)
  526 |             const open = await bridge.openProject(String(project.id))
  527 |             return {
  528 |               projectId: String(project.id),
  529 |               repoExecutionHostId:
  530 |                 typeof repo?.executionHostId === 'string' ? repo.executionHostId : null,
  531 |               activeWorktreePath: typeof worktree?.path === 'string' ? worktree.path : null,
  532 |               open: {
  533 |                 ok: open.ok === true,
  534 |                 route: typeof open.route === 'string' ? open.route : null,
  535 |                 connectDiagnostics: open.connectDiagnostics ?? null
  536 |               }
  537 |             }
  538 |           },
  539 |           { projectKey: PROJECT_KEY, projectPath: session.projectPath }
  540 |         )
  541 |         expect(result.repoExecutionHostId, 'repo must be runtime-backed').toMatch(/^runtime:/)
  542 |         expect(
  543 |           result.activeWorktreePath,
  544 |           'the opened workspace must be the per-user checkout under the project'
  545 |         ).toContain(`${PROJECT_NAME}/.orca-worktrees/${DEVELOPER}`)
  546 |         expect(result.open?.ok, JSON.stringify(result.open)).toBe(true)
  547 |         expect(result.open?.route, 'the chosen line must be direct').toBe('direct')
  548 |         expect(
  549 |           Array.isArray((result.open?.connectDiagnostics as { probes?: unknown[] })?.probes),
  550 |           'connect diagnostics must carry the probe list'
  551 |         ).toBe(true)
  552 |         // W9A-1 regression: the row appeared and vanished moments after sign-in
  553 |         // once the startup catalog load pruned it — it has to survive the settle.
  554 |         await page.waitForTimeout(2_000)
  555 |         expect(
  556 |           await page.evaluate(
  557 |             (projectPath) =>
  558 |               (window.__store?.getState()?.repos ?? []).some((repo) => repo.path === projectPath),
  559 |             session.projectPath
  560 |           ),
  561 |           'the cloud project row must survive the post-open settle window'
  562 |         ).toBe(true)
  563 |         await shoot(page, '02-workspace-opened')
  564 |         return result
  565 |       },
  566 |       (result) => ({
  567 |         projectId: result.projectId,
  568 |         repoExecutionHostId: result.repoExecutionHostId,
  569 |         workspacePath: result.activeWorktreePath,
  570 |         route: result.open?.route,
  571 |         probes: result.open?.connectDiagnostics
  572 |       })
  573 |     )
  574 | 
  575 |     // ── A4 · 终端输入与回显 ─────────────────────────────────────────
  576 |     await journeyStep(
  577 |       'A4-terminal',
  578 |       '终端输入 echo orca-journey && ls，断言回显与输出',
  579 |       async () => {
  580 |         await ensureTerminalVisible(page, 30_000)
  581 |         await waitForActiveTerminalManager(page, 30_000)
  582 |         const ptyId = await waitForActivePanePtyId(page, 60_000)
  583 |         // A runtime-backed workspace keeps its shell on the host, so the pane binds
  584 |         // a `remote:` handle and `pty:hasPty` honestly answers null for it — the
  585 |         // local daemon can never verify another host's PTY (inspect.ts). Liveness
  586 |         // is what the stream below proves: the typed line must come back echoed,
  587 |         // with its output, through the workspace's terminal.multiplex stream.
  588 |         expect(ptyId, 'the pane must bind a remote-runtime PTY handle').toMatch(/^remote:/)
  589 |         const localVerdict = await page.evaluate((id) => window.api.pty.hasPty(id), ptyId)
  590 |         expect(localVerdict, 'a remote handle must be unverifiable locally, not dead').toBeNull()
  591 |         await focusActiveTerminalInput(page)
  592 |         const sentAt = Date.now()
  593 |         await page.keyboard.type(`echo ${RUN_MARKER} && ls`)
  594 |         await page.keyboard.press('Enter')
  595 |         let outputMs = -1
  596 |         await expect
  597 |           .poll(
  598 |             async () => {
  599 |               const content = await getTerminalLogicalContent(page, 8000)
  600 |               if (content.includes(FILE_NAME) && content.includes('README.md') && outputMs < 0) {
  601 |                 outputMs = Date.now() - sentAt
```