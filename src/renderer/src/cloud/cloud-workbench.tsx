import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { CloudProjectSummary } from '../../../shared/cloud-platform-ipc'
import type { CloudSessionView } from './use-cloud-session'

export type CloudWorkbenchProps = {
  session: CloudSessionView
  onOpenProject: (projectId: string) => void
}

function routeLabel(route: 'direct' | 'relay' | null): string {
  if (route === 'direct') {
    return '直连'
  }
  return route === 'relay' ? '中继' : ''
}

export function CloudProjectRow({
  project,
  isOpen,
  onOpen
}: {
  project: CloudProjectSummary
  isOpen: boolean
  onOpen: () => void
}): React.JSX.Element {
  return (
    <div
      data-current={isOpen || undefined}
      className="flex items-center justify-between gap-4 rounded-lg px-4 py-3 transition-colors hover:bg-accent"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{project.name}</span>
          {project.hostStatus !== 'online' ? (
            <Badge variant="outline" className="text-muted-foreground">
              主机离线
            </Badge>
          ) : null}
        </div>
        <span className="truncate text-xs text-muted-foreground">
          {project.key}
          {project.hostName ? ` · ${project.hostName}` : ''}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {project.downloadRestricted ? (
          // Capability notice, not a control: the host enforces it (FR-7.3).
          <span className="text-xs text-muted-foreground">下载受限</span>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          onClick={onOpen}
          disabled={project.hostStatus !== 'online'}
        >
          {isOpen ? '已打开' : '打开'}
        </Button>
      </div>
    </div>
  )
}

export function CloudWorkbench({ session, onOpenProject }: CloudWorkbenchProps): React.JSX.Element {
  if (session.status !== 'signed-in') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        正在加载…
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-base font-medium text-foreground">工作台</h1>
          <p className="text-xs text-muted-foreground">
            {session.displayName} · 共 {session.projects.length} 个项目
          </p>
        </div>
        <div className="flex items-center gap-3">
          {session.openProjectId ? (
            <Badge variant="secondary" data-testid="cloud-route">
              {routeLabel(session.route)}
            </Badge>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => void session.signOut()}>
            退出登录
          </Button>
        </div>
      </header>

      {session.notice ? (
        <div
          role="status"
          className="border-b border-border bg-muted px-6 py-2 text-sm text-muted-foreground"
        >
          {session.notice.code === 4403
            ? '当前连接已被管理员收回，请重新登录或联系平台管理员。'
            : '连接已断开，请重新打开项目。'}
        </div>
      ) : null}
      {session.error ? (
        <div role="alert" className="border-b border-border px-6 py-2 text-sm text-destructive">
          操作失败（{session.error}）
        </div>
      ) : null}

      <div className="scrollbar-sleek flex-1 overflow-y-auto px-4 py-3">
        {session.projects.length === 0 ? (
          <p className="px-2 py-6 text-sm text-muted-foreground">
            暂无可访问的项目，请联系平台管理员授权。
          </p>
        ) : (
          <div className="flex flex-col">
            {session.projects.map((project) => (
              <CloudProjectRow
                key={project.id}
                project={project}
                isOpen={session.openProjectId === project.id}
                onOpen={() => onOpenProject(project.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
