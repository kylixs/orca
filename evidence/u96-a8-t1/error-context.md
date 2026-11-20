# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: cloud-golden-journey-git-and-restart.spec.ts >> U96 A1 Orca Web 页面重载：2 组 3 标签、活动标签与活 PTY marker 恢复
- Location: tests/e2e/cloud-golden-journey-git-and-restart.spec.ts:517:5

# Error details

```
Error: page.evaluate: Error: the split created no second group
    at eval (eval at evaluate (:311:30), <anonymous>:92:15)
    at async <anonymous>:337:30
```

# Page snapshot

```yaml
- generic [active] [ref=f1e1]:
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
                    - generic [ref=f1e216]: 669.7 MB
                    - generic [ref=f1e217]: ·
                    - generic [ref=f1e220]: '5'
                - button "端口，0 工作区 ports" [ref=f1e221] [cursor=pointer]:
                    - generic [ref=f1e224]: '0'
                - button "登录云端平台" [ref=f1e225] [cursor=pointer]
            - button [aria-hidden]
        - region "Notifications alt+T"
    - generic [ref=f1e226]:
        - tooltip "工作区板已移到底部栏"
```
