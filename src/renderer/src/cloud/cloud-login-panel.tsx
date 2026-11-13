import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cloudCloseNotice } from './cloud-close-notice'

export type CloudLoginPanelProps = {
  submitting: boolean
  error: string | null
  /** Why the user was returned here, e.g. an expired platform session. */
  notice?: { code: number | null; reason: string | null } | null
  onSignIn: (username: string, password: string) => void
}

/** Error codes come from the platform; the copy is ours (AC-30 vocabulary). */
const ERROR_COPY: Record<string, string> = {
  INVALID_CREDENTIALS: '账号或密码不正确。',
  ACCOUNT_LOCKED: '账号已锁定，请 15 分钟后再试。',
  RATE_LIMITED: '尝试过于频繁，请稍后再试。',
  PLATFORM_UNAVAILABLE: '平台暂不可用，请稍后再试。'
}

export function cloudErrorMessage(code: string | null): string | null {
  if (!code) {
    return null
  }
  return ERROR_COPY[code] ?? `登录失败（${code}）。`
}

export function CloudLoginPanel({
  submitting,
  error,
  notice,
  onSignIn
}: CloudLoginPanelProps): React.JSX.Element {
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const canSubmit = username.trim().length > 0 && password.length > 0 && !submitting

  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-xl border border-border/50 bg-card p-8 shadow-sm">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium text-foreground">登录云端开发平台</h1>
          <p className="text-sm text-muted-foreground">使用公司域账号登录后选择项目。</p>
        </div>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit) {
              onSignIn(username.trim(), password)
            }
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="cloud-username">域账号</Label>
            <Input
              id="cloud-username"
              autoComplete="username"
              autoFocus
              value={username}
              disabled={submitting}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="cloud-password">密码</Label>
            <Input
              id="cloud-password"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={submitting}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {notice ? (
            <p role="status" className="text-sm text-muted-foreground">
              {cloudCloseNotice(notice.code)}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {cloudErrorMessage(error)}
            </p>
          ) : null}
          <Button type="submit" disabled={!canSubmit}>
            {submitting ? '登录中…' : '登录'}
          </Button>
        </form>
      </div>
    </div>
  )
}
