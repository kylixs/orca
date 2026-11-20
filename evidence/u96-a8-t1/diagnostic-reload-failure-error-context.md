# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: cloud-golden-journey-git-and-restart.spec.ts >> U96 A1 Orca Web 页面重载：2 组 3 标签、活动标签与活 PTY marker 恢复
- Location: tests/e2e/cloud-golden-journey-git-and-restart.spec.ts:517:5

# Error details

```
TimeoutError: page.waitForSelector: Timeout 180000ms exceeded.
Call log:
  - waiting for locator('.app-layout') to be visible

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
                - generic [ref=f1e216]: 672.6 MB
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
  677 |         const beforeReload = await waitForList(
  678 |           (snapshot) =>
  679 |             (((field(snapshot, 'tabGroups') as unknown[]) ?? []).length >= 2) &&
  680 |             text(snapshot, 'activeTabId') === created[1]!.surfaceId
  681 |         )
  682 |         const beforeTabs = ((field(beforeReload, 'tabs') as unknown[]) ?? []).map((tab) => ({
  683 |           id: text(tab, 'id'),
  684 |           title: text(tab, 'title')
  685 |         }))
  686 |         const beforeGroups = ((field(beforeReload, 'tabGroups') as unknown[]) ?? []).map(
  687 |           (group) => ({
  688 |             id: text(group, 'id'),
  689 |             tabOrder: (field(group, 'tabOrder') as string[]) ?? []
  690 |           })
  691 |         )
  692 |         return {
  693 |           worktreeId,
  694 |           environmentId,
  695 |           created,
  696 |           beforeTabs,
  697 |           beforeGroups,
  698 |           activeHostTabId: text(beforeReload, 'activeTabId'),
  699 |           activeGroupId: text(beforeReload, 'activeGroupId')
  700 |         }
  701 |       },
  702 |       { markerOne: U96_E2E_MARKER_ONE, markerTwo: U96_E2E_MARKER_TWO }
  703 |     )
  704 |
  705 |     const expectedTabCount = setup.beforeTabs.length
  706 |     expect(setup.beforeGroups.length, 'two groups exist before the reload').toBe(2)
  707 |     expect(setup.activeHostTabId, 'the split-group terminal is the active tab').toBe(
  708 |       setup.created[1]!.surfaceId
  709 |     )
  710 |     const activeLocalId = localWebTabId(setup.created[1]!.parentTabId)
  711 |     const firstCreatedLocalId = localWebTabId(setup.created[0]!.parentTabId)
  712 |
  713 |     // DIAGNOSTIC-ONLY: capture host vs store when the mirror does not converge.
  714 |     try {
  715 |     await expect
  716 |       .poll(
  717 |         async () =>
  718 |           page.evaluate(
  719 |             ({ worktreeId }) => {
  720 |               const state = window.__store?.getState?.()
  721 |               return {
  722 |                 tabs: (state?.tabsByWorktree?.[worktreeId] ?? []).length,
  723 |                 domTabs: document.querySelectorAll('[data-testid="sortable-tab"]').length
  724 |               }
  725 |             },
  726 |             { worktreeId: setup.worktreeId }
  727 |           ),
  728 |         { timeout: 20_000, message: 'the split/move never reached the Orca Web tab strip' }
  729 |       )
  730 |       .toEqual({
  731 |         tabs: expectedTabCount,
  732 |         domTabs: expectedTabCount
  733 |       })
  734 |     } catch (error) {
  735 |       const store = await page.evaluate(
  736 |         ({ worktreeId }) => {
  737 |           const state = window.__store?.getState?.()
  738 |           return {
  739 |             groups: (state?.groupsByWorktree?.[worktreeId] ?? []).map((group) => ({
  740 |               id: group.id,
  741 |               tabOrder: [...group.tabOrder],
  742 |               activeTabId: group.activeTabId
  743 |             })),
  744 |             layout: state?.layoutByWorktree?.[worktreeId] ?? null,
  745 |             activeGroup: state?.activeGroupIdByWorktree?.[worktreeId] ?? null,
  746 |             active: state?.activeTabIdByWorktree?.[worktreeId] ?? null,
  747 |             tabs: (state?.tabsByWorktree?.[worktreeId] ?? []).map((tab) => ({
  748 |               id: tab.id,
  749 |               title: tab.title
  750 |             })),
  751 |             layoutKeys: Object.keys(state?.layoutByWorktree ?? {})
  752 |           }
  753 |         },
  754 |         { worktreeId: setup.worktreeId }
  755 |       );
  756 |       writeEvidence('u96-a1-diag-mirror.json', {
  757 |         host: {
  758 |           groups: setup.beforeGroups,
  759 |           tabs: setup.beforeTabs,
  760 |           active: setup.activeHostTabId,
  761 |           activeGroup: setup.activeGroupId
  762 |         },
  763 |         store
  764 |       })
  765 |       throw error
  766 |     }
  767 |     await page.screenshot({ path: path.join(EVIDENCE_DIR, 'u96-a1-before-reload.png') })
  768 |
  769 |     const requests: { method: string; path: string }[] = []
  770 |     page.on('request', (request) => {
  771 |       const parsed = new URL(request.url())
  772 |       if (parsed.pathname.startsWith('/v1/')) {
  773 |         requests.push({ method: request.method(), path: parsed.pathname })
  774 |       }
  775 |     })
  776 |     await page.reload({ waitUntil: 'domcontentloaded' })
> 777 |     await page.waitForSelector('.app-layout', { timeout: WORKSPACE_TIMEOUT_MS })
      |                ^ TimeoutError: page.waitForSelector: Timeout 180000ms exceeded.
  778 |
  779 |     // What the user sees after the reload: same checkout, same three-terminal
  780 |     // layout in two panes, the same tab selected.
  781 |     await expect
  782 |       .poll(
  783 |         async () =>
  784 |           page.evaluate(
  785 |             ({ worktreeId, activeTabId }) => {
  786 |               const state = window.__store?.getState?.()
  787 |               const tabs = state?.tabsByWorktree?.[worktreeId] ?? []
  788 |               return {
  789 |                 repos: state?.repos?.length ?? 0,
  790 |                 tabs: tabs.length,
  791 |                 groups: (state?.groupsByWorktree?.[worktreeId] ?? []).length,
  792 |                 active: state?.activeTabIdByWorktree?.[worktreeId] ?? null,
  793 |                 domTabs: document.querySelectorAll('[data-testid="sortable-tab"]').length,
  794 |                 domStrips: document.querySelectorAll('.terminal-tab-strip').length,
  795 |                 domActive:
  796 |                   document
  797 |                     .querySelector('[data-testid="sortable-tab"][data-active="true"]')
  798 |                     ?.getAttribute('data-tab-id') ?? null,
  799 |                 expectedActive: activeTabId,
  800 |                 signIn: document.querySelector('#web-cloud-api-url') !== null
  801 |               }
  802 |             },
  803 |             { worktreeId: setup.worktreeId, activeTabId: activeLocalId }
  804 |           ),
  805 |         { timeout: 180_000, message: 'the reload did not restore the tab group layout' }
  806 |       )
  807 |       .toEqual({
  808 |         repos: 1,
  809 |         tabs: expectedTabCount,
  810 |         groups: 2,
  811 |         active: activeLocalId,
  812 |         domTabs: expectedTabCount,
  813 |         domStrips: 2,
  814 |         domActive: activeLocalId,
  815 |         expectedActive: activeLocalId,
  816 |         signIn: false
  817 |       })
  818 |
  819 |     // Group membership, not just the count: each pane keeps its own tabs.
  820 |     const restoredGroups = await page.evaluate(
  821 |       ({ worktreeId }) => {
  822 |         const state = window.__store?.getState?.()
  823 |         return (state?.groupsByWorktree?.[worktreeId] ?? []).map((group) => [...group.tabOrder])
  824 |       },
  825 |       { worktreeId: setup.worktreeId }
  826 |     )
  827 |     expect(restoredGroups.length).toBe(2)
  828 |     expect(
  829 |       restoredGroups.every((order) => order.length > 0),
  830 |       'no group lost its tabs'
  831 |     ).toBe(true)
  832 |
  833 |     const reauth = requests.filter(
  834 |       (call) => call.path === '/v1/auth/login' || call.path === '/v1/web/handoff'
  835 |     )
  836 |     expect(reauth, 'a reload must not re-authenticate by login or handoff').toEqual([])
  837 |
  838 |     // Live PTY content: select each restored terminal and read its pane. The
  839 |     // marker exists in no client buffer — the host stream replays it.
  840 |     const readMarker = async (localTabId: string, marker: string): Promise<void> => {
  841 |       await page.locator(`[data-testid="sortable-tab"][data-tab-id="${localTabId}"]`).click()
  842 |       await expect
  843 |         .poll(async () => getTerminalContent(page, 10_000), {
  844 |           timeout: 120_000,
  845 |           message: `the live PTY marker never rendered in the restored pane ${localTabId}`
  846 |         })
  847 |         .toContain(marker)
  848 |     }
  849 |     await readMarker(firstCreatedLocalId, U96_E2E_MARKER_ONE)
  850 |     await readMarker(activeLocalId, U96_E2E_MARKER_TWO)
  851 |     await page.screenshot({ path: path.join(EVIDENCE_DIR, 'u96-a1-after-reload.png') })
  852 |
  853 |     writeEvidence('u96-a1-orca-web-reload.json', {
  854 |       station: 'U96-A1',
  855 |       entry: 'web-index.html?api=<platform>#handoff=<code>',
  856 |       markerOne: U96_E2E_MARKER_ONE,
  857 |       markerTwo: U96_E2E_MARKER_TWO,
  858 |       worktreeId: setup.worktreeId,
  859 |       createdHostTabIds: setup.created.map((entry) => entry.parentTabId),
  860 |       before: {
  861 |         tabCount: expectedTabCount,
  862 |         groupCount: setup.beforeGroups.length,
  863 |         groups: setup.beforeGroups,
  864 |         activeTabId: setup.activeHostTabId,
  865 |         activeGroupId: setup.activeGroupId
  866 |       },
  867 |       after: {
  868 |         tabCount: expectedTabCount,
  869 |         groupCount: restoredGroups.length,
  870 |         groups: restoredGroups,
  871 |         activeLocalTabId: activeLocalId,
  872 |         markersVisible: [U96_E2E_MARKER_ONE, U96_E2E_MARKER_TWO],
  873 |         reauthenticationCalls: reauth
  874 |       },
  875 |       screenshots: ['u96-a1-before-reload.png', 'u96-a1-after-reload.png']
  876 |     })
  877 |     await context.close()
```
