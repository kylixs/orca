# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: cloud-golden-journey-git-and-restart.spec.ts >> U96 A1 Orca Web 页面重载：2 组 3 标签、活动标签与活 PTY marker 恢复
- Location: tests/e2e/cloud-golden-journey-git-and-restart.spec.ts:517:5

# Error details

```
Error: the reload did not restore the tab group layout

the reload did not restore the tab group layout

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 1

@@ -1,8 +1,8 @@
  Object {
    "active": "web-terminal-a3d3ff31-c0b9-4d2e-a0be-9a14d76897dc",
-   "domActive": "web-terminal-a3d3ff31-c0b9-4d2e-a0be-9a14d76897dc",
+   "domActive": "web-terminal-e220a3d8-af64-42bc-b74d-5b49ceda27b2",
    "domStrips": 2,
    "domTabs": 5,
    "expectedActive": "web-terminal-a3d3ff31-c0b9-4d2e-a0be-9a14d76897dc",
    "groups": 2,
    "repos": 1,

Call Log:
- Timeout 180000ms exceeded while waiting on the predicate
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
                        - generic [ref=f1e31]:
                            - button "任务" [ref=f1e32] [cursor=pointer]
                            - generic:
                                - button "打开 GitHub 任务"
                                - button "打开 Jira 任务"
                        - button "自动化" [ref=f1e35] [cursor=pointer]
                        - button "Orca 手机端 新功能" [ref=f1e42] [cursor=pointer]:
                            - generic [ref=f1e45]: Orca 手机端
                            - generic [ref=f1e46]: 新功能
                    - generic [ref=f1e47]:
                        - generic [ref=f1e48]: 项目
                        - generic [ref=f1e50]:
                            - button "查看活动" [ref=f1e52] [cursor=pointer]
                            - generic [ref=f1e53]:
                                - button "工作区选项" [ref=f1e54] [cursor=pointer]
                                - button "添加项目" [ref=f1e55] [cursor=pointer]
                                - button "新工作区" [ref=f1e56] [cursor=pointer]
                    - listbox "工作树" [ref=f1e58]:
                        - button "u91-git u91-git 的项目操作 为 u91-git 创建新工作树" [expanded] [ref=f1e59] [cursor=pointer]:
                            - generic [ref=f1e60]: u91-git
                            - generic:
                                - button "u91-git 的项目操作"
                                - button "为 u91-git 创建新工作树"
                        - option "Mark as unread Inactive main 主要 main" [ref=f1e68]:
                            - generic [ref=f1e69]:
                                - generic [ref=f1e71] [cursor=pointer]:
                                    - generic [ref=f1e72]:
                                        - button "Mark as unread" [ref=f1e73]
                                        - generic [ref=f1e79]: Inactive
                                    - generic [ref=f1e81]:
                                        - generic [ref=f1e83]:
                                            - generic [ref=f1e84]: main
                                            - generic [ref=f1e85]: 主要
                                        - generic [ref=f1e86]: main
                                - button [aria-hidden]
                        - option "Mark as unread Active main e2e/main" [ref=f1e89]:
                            - generic [ref=f1e90]:
                                - generic [ref=f1e92] [cursor=pointer]:
                                    - generic [ref=f1e93]:
                                        - button "Mark as unread" [ref=f1e94]
                                        - generic [ref=f1e100]: Active
                                    - generic [ref=f1e102]:
                                        - generic [ref=f1e103]: main
                                        - generic [ref=f1e106]: e2e/main
                                - button [aria-hidden]
                    - generic [ref=f1e111]:
                        - generic [ref=f1e113]:
                            - button "设置" [ref=f1e114] [cursor=pointer]
                            - button "帮助" [ref=f1e115] [cursor=pointer]
                        - generic [ref=f1e116]:
                            - button "显示活动工作区" [ref=f1e117] [cursor=pointer]
                            - button "工作区板" [ref=f1e118] [cursor=pointer]
            - generic [ref=f1e123]:
                - generic [ref=f1e127]:
                    - img "Orca 标志" [ref=f1e129]
                    - heading "ORCA" [level=1] [ref=f1e130]
                    - paragraph [ref=f1e131]: 从侧边栏中选择一个工作区开始。
                    - generic [ref=f1e132]:
                        - button "添加项目" [ref=f1e133] [cursor=pointer]
                        - button "创建 worktree" [ref=f1e136] [cursor=pointer]
                    - generic [ref=f1e141]:
                        - generic [ref=f1e142]:
                            - generic [ref=f1e143]: Create worktree
                            - generic [ref=f1e144]:
                                - generic [ref=f1e145]: ⌘
                                - generic [ref=f1e146]: 'N'
                        - generic [ref=f1e147]:
                            - generic [ref=f1e148]: Move up workspace
                            - generic [ref=f1e149]:
                                - generic [ref=f1e150]: ⌘
                                - generic [ref=f1e151]: ⇧
                                - generic [ref=f1e152]: ↑
                        - generic [ref=f1e153]:
                            - generic [ref=f1e154]: Move down workspace
                            - generic [ref=f1e155]:
                                - generic [ref=f1e156]: ⌘
                                - generic [ref=f1e157]: ⇧
                                - generic [ref=f1e158]: ↓
                - button "显示浮动工作区" [ref=f1e160]
                - button [aria-hidden]
        - generic [ref=f1e162]:
            - generic [ref=f1e163]:
                - generic [ref=f1e166]:
                    - button "Explorer (⌘⇧E)" [ref=f1e167] [cursor=pointer]
                    - button "Agents" [ref=f1e173] [cursor=pointer]
                    - button "Source Control (⌘⇧G)" [ref=f1e180] [cursor=pointer]
                    - button "Checks" [ref=f1e185] [cursor=pointer]
                - button "Toggle right sidebar" [ref=f1e190] [cursor=pointer]
            - generic [ref=f1e193]: 选择一个工作区来浏览文件
    - generic [ref=f1e197]:
        - button "刷新速率限制" [ref=f1e200] [cursor=pointer]
        - generic [ref=f1e207]:
            - button "防止电脑休眠，关闭 · 未生效" [ref=f1e208] [cursor=pointer]:
                - generic [ref=f1e211]: 关闭
            - button "资源管理器，5 个终端会话" [ref=f1e213] [cursor=pointer]:
                - generic [ref=f1e216]: 663.7 MB
                - generic [ref=f1e217]: ·
                - generic [ref=f1e220]: '5'
            - button "端口，0 工作区 ports" [ref=f1e221] [cursor=pointer]:
                - generic [ref=f1e224]: '0'
            - button "登录云端平台" [ref=f1e225] [cursor=pointer]
        - button [aria-hidden]
    - region "Notifications alt+T"
```

# Test source

```ts
  685 |         const beforeReload = await waitForList(
  686 |           (snapshot) =>
  687 |             groupIds(snapshot).length >= 2 &&
  688 |             text(snapshot, 'activeTabId') === created[1]!.surfaceId
  689 |         )
  690 |         const beforeTabs = ((field(beforeReload, 'tabs') as unknown[]) ?? []).map((tab) => ({
  691 |           id: text(tab, 'id'),
  692 |           title: text(tab, 'title')
  693 |         }))
  694 |         const beforeGroups = ((field(beforeReload, 'tabGroups') as unknown[]) ?? []).map(
  695 |           (group) => ({
  696 |             id: text(group, 'id'),
  697 |             tabOrder: (field(group, 'tabOrder') as string[]) ?? []
  698 |           })
  699 |         )
  700 |         return {
  701 |           worktreeId,
  702 |           environmentId,
  703 |           created,
  704 |           beforeTabs,
  705 |           beforeGroups,
  706 |           activeHostTabId: text(beforeReload, 'activeTabId'),
  707 |           activeGroupId: text(beforeReload, 'activeGroupId')
  708 |         }
  709 |       },
  710 |       { markerOne: U96_E2E_MARKER_ONE, markerTwo: U96_E2E_MARKER_TWO }
  711 |     )
  712 |
  713 |     const expectedTabCount = setup.beforeTabs.length
  714 |     expect(setup.beforeGroups.length, 'two groups exist before the reload').toBe(2)
  715 |     expect(setup.activeHostTabId, 'the split-group terminal is the active tab').toBe(
  716 |       setup.created[1]!.surfaceId
  717 |     )
  718 |     const activeLocalId = localWebTabId(setup.created[1]!.parentTabId)
  719 |     const firstCreatedLocalId = localWebTabId(setup.created[0]!.parentTabId)
  720 |
  721 |     // Why: once a worktree has client groups, placement is client-owned —
  722 |     // snapshots append tabs but never re-apply host order/active/layout
  723 |     // (apply-preparation-groups.ts). So the 2-pane split asserted above is a
  724 |     // host-side contract, not a local mirror contract. Only wait for the
  725 |     // created tabs to reach the visible strip before the reload under test.
  726 |     await expect
  727 |       .poll(
  728 |         async () =>
  729 |           page.evaluate(
  730 |             ({ worktreeId }) => {
  731 |               const state = window.__store?.getState?.()
  732 |               return {
  733 |                 tabs: (state?.tabsByWorktree?.[worktreeId] ?? []).length,
  734 |                 domTabs: document.querySelectorAll('[data-testid="sortable-tab"]').length
  735 |               }
  736 |             },
  737 |             { worktreeId: setup.worktreeId }
  738 |           ),
  739 |         { timeout: 120_000, message: 'the created tabs never reached the Orca Web tab strip' }
  740 |       )
  741 |       .toEqual({ tabs: expectedTabCount, domTabs: expectedTabCount })
  742 |     await page.screenshot({ path: path.join(EVIDENCE_DIR, 'u96-a1-before-reload.png') })
  743 |
  744 |     const requests: { method: string; path: string }[] = []
  745 |     page.on('request', (request) => {
  746 |       const parsed = new URL(request.url())
  747 |       if (parsed.pathname.startsWith('/v1/')) {
  748 |         requests.push({ method: request.method(), path: parsed.pathname })
  749 |       }
  750 |     })
  751 |     // KNOWN RED until the product decides whether a web reload resumes the host
  752 |     // session (today it lands on the sign-in shell). The reload assertions below
  753 |     // are kept as the target contract for that fix.
  754 |     await page.reload({ waitUntil: 'domcontentloaded' })
  755 |     await page.waitForSelector('.app-layout', { timeout: WORKSPACE_TIMEOUT_MS })
  756 |
  757 |     // What the user sees after the reload: same checkout, same three-terminal
  758 |     // layout in two panes, the same tab selected.
  759 |     await expect
  760 |       .poll(
  761 |         async () =>
  762 |           page.evaluate(
  763 |             ({ worktreeId, activeTabId }) => {
  764 |               const state = window.__store?.getState?.()
  765 |               const tabs = state?.tabsByWorktree?.[worktreeId] ?? []
  766 |               return {
  767 |                 repos: state?.repos?.length ?? 0,
  768 |                 tabs: tabs.length,
  769 |                 groups: (state?.groupsByWorktree?.[worktreeId] ?? []).length,
  770 |                 active: state?.activeTabIdByWorktree?.[worktreeId] ?? null,
  771 |                 domTabs: document.querySelectorAll('[data-testid="sortable-tab"]').length,
  772 |                 domStrips: document.querySelectorAll('.terminal-tab-strip').length,
  773 |                 domActive:
  774 |                   document
  775 |                     .querySelector('[data-testid="sortable-tab"][data-active="true"]')
  776 |                     ?.getAttribute('data-tab-id') ?? null,
  777 |                 expectedActive: activeTabId,
  778 |                 signIn: document.querySelector('#web-cloud-api-url') !== null
  779 |               }
  780 |             },
  781 |             { worktreeId: setup.worktreeId, activeTabId: activeLocalId }
  782 |           ),
  783 |         { timeout: 180_000, message: 'the reload did not restore the tab group layout' }
  784 |       )
> 785 |       .toEqual({
      |        ^ Error: the reload did not restore the tab group layout
  786 |         repos: 1,
  787 |         tabs: expectedTabCount,
  788 |         groups: 2,
  789 |         active: activeLocalId,
  790 |         domTabs: expectedTabCount,
  791 |         domStrips: 2,
  792 |         domActive: activeLocalId,
  793 |         expectedActive: activeLocalId,
  794 |         signIn: false
  795 |       })
  796 |
  797 |     // Group membership, not just the count: each pane keeps its own tabs.
  798 |     const restoredGroups = await page.evaluate(
  799 |       ({ worktreeId }) => {
  800 |         const state = window.__store?.getState?.()
  801 |         return (state?.groupsByWorktree?.[worktreeId] ?? []).map((group) => [...group.tabOrder])
  802 |       },
  803 |       { worktreeId: setup.worktreeId }
  804 |     )
  805 |     expect(restoredGroups.length).toBe(2)
  806 |     expect(
  807 |       restoredGroups.every((order) => order.length > 0),
  808 |       'no group lost its tabs'
  809 |     ).toBe(true)
  810 |
  811 |     const reauth = requests.filter(
  812 |       (call) => call.path === '/v1/auth/login' || call.path === '/v1/web/handoff'
  813 |     )
  814 |     expect(reauth, 'a reload must not re-authenticate by login or handoff').toEqual([])
  815 |
  816 |     // Live PTY content: select each restored terminal and read its pane. The
  817 |     // marker exists in no client buffer — the host stream replays it.
  818 |     const readMarker = async (localTabId: string, marker: string): Promise<void> => {
  819 |       await page.locator(`[data-testid="sortable-tab"][data-tab-id="${localTabId}"]`).click()
  820 |       await expect
  821 |         .poll(async () => getTerminalContent(page, 10_000), {
  822 |           timeout: 120_000,
  823 |           message: `the live PTY marker never rendered in the restored pane ${localTabId}`
  824 |         })
  825 |         .toContain(marker)
  826 |     }
  827 |     await readMarker(firstCreatedLocalId, U96_E2E_MARKER_ONE)
  828 |     await readMarker(activeLocalId, U96_E2E_MARKER_TWO)
  829 |     await page.screenshot({ path: path.join(EVIDENCE_DIR, 'u96-a1-after-reload.png') })
  830 |
  831 |     writeEvidence('u96-a1-orca-web-reload.json', {
  832 |       station: 'U96-A1',
  833 |       entry: 'web-index.html?api=<platform>#handoff=<code>',
  834 |       markerOne: U96_E2E_MARKER_ONE,
  835 |       markerTwo: U96_E2E_MARKER_TWO,
  836 |       worktreeId: setup.worktreeId,
  837 |       createdHostTabIds: setup.created.map((entry) => entry.parentTabId),
  838 |       before: {
  839 |         tabCount: expectedTabCount,
  840 |         groupCount: setup.beforeGroups.length,
  841 |         groups: setup.beforeGroups,
  842 |         activeTabId: setup.activeHostTabId,
  843 |         activeGroupId: setup.activeGroupId
  844 |       },
  845 |       after: {
  846 |         tabCount: expectedTabCount,
  847 |         groupCount: restoredGroups.length,
  848 |         groups: restoredGroups,
  849 |         activeLocalTabId: activeLocalId,
  850 |         markersVisible: [U96_E2E_MARKER_ONE, U96_E2E_MARKER_TWO],
  851 |         reauthenticationCalls: reauth
  852 |       },
  853 |       screenshots: ['u96-a1-before-reload.png', 'u96-a1-after-reload.png']
  854 |     })
  855 |     await context.close()
  856 |   } finally {
  857 |     await browser.close()
  858 |   }
  859 | })
  860 |
```
