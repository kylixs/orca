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
  /** Address prefilled from the last successful login or the build default; null asks the user. */
  defaultPlatformUrl?: string | null
  /** Username remembered from the last successful login. */
  defaultUsername?: string | null
  /** A managed build pins the address: the field shows it read-only. */
  addressLocked?: boolean
  onSignIn: (username: string, password: string, platformUrl: string) => void
}

/** Error codes come from the platform; the copy is ours (AC-30 vocabulary). */
const ERROR_COPY: Record<string, string> = {
  INVALID_CREDENTIALS: '账号或密码不正确。',
  ACCOUNT_LOCKED: '账号已锁定，请 15 分钟后再试。',
  RATE_LIMITED: '尝试过于频繁，请稍后再试。',
  PLATFORM_UNAVAILABLE: '平台暂不可用，请稍后再试。',
  PLATFORM_ADDRESS_REQUIRED: '请填写平台地址。',
  PLATFORM_ADDRESS_INVALID: '平台地址格式不正确，需为 https:// 开头的完整地址。'
}

export function cloudErrorMessage(code: string | null): string | null {
  if (!code) {
    return null
  }
  return ERROR_COPY[code] ?? `登录失败（${code}）。`
}

/**
 * Inline address check (M119/W10): it only judges shape, so a dev platform on
 * http://127.0.0.1 still passes and the packaged policy (https only) stays with
 * the main process, which answers with PLATFORM_ADDRESS_INVALID.
 */
export function cloudPlatformAddressError(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return '请填写平台地址。'
  }
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '平台地址格式不正确，需为 https:// 开头的完整地址。'
    }
    return null
  } catch {
    return '平台地址格式不正确，需为 https:// 开头的完整地址。'
  }
}

export function CloudLoginPanel(props: CloudLoginPanelProps): React.JSX.Element {
  const {
    submitting,
    error,
    notice,
    defaultPlatformUrl,
    defaultUsername,
    addressLocked,
    onSignIn
  } = props
  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-xl border border-border/50 bg-card p-8 shadow-sm">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium text-foreground">登录云端开发平台</h1>
          <p className="text-sm text-muted-foreground">使用公司域账号登录后选择项目。</p>
        </div>
        <CloudLoginForm
          submitting={submitting}
          error={error}
          notice={notice}
          defaultPlatformUrl={defaultPlatformUrl}
          defaultUsername={defaultUsername}
          addressLocked={addressLocked}
          onSignIn={onSignIn}
        />
      </div>
    </div>
  )
}

/**
 * The address + account fields, shared by the full-page login (admin session
 * page) and the native shell's sign-in dialog (W11).
 */
export function CloudLoginForm(props: CloudLoginPanelProps): React.JSX.Element {
  const {
    submitting,
    error,
    notice,
    defaultPlatformUrl,
    defaultUsername,
    addressLocked,
    onSignIn
  } = props
  // Why drafts over initial state: the login context arrives after the first
  // paint (the login screen is never held back for it), so the remembered
  // address and username are what the field shows until the user types over it.
  const [usernameDraft, setUsernameDraft] = React.useState<string | null>(null)
  const [password, setPassword] = React.useState('')
  const [addressDraft, setAddressDraft] = React.useState<string | null>(null)
  const [addressError, setAddressError] = React.useState<string | null>(null)
  const username = usernameDraft ?? defaultUsername ?? ''
  const platformUrl = addressDraft ?? defaultPlatformUrl ?? ''

  const canSubmit =
    username.trim().length > 0 &&
    password.length > 0 &&
    platformUrl.trim().length > 0 &&
    !submitting

  const submit = (): void => {
    const addressProblem = cloudPlatformAddressError(platformUrl)
    if (addressProblem) {
      setAddressError(addressProblem)
      return
    }
    setAddressError(null)
    onSignIn(username.trim(), password, platformUrl.trim())
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit) {
          submit()
        }
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="cloud-platform-address">平台地址</Label>
        <Input
          id="cloud-platform-address"
          inputMode="url"
          spellCheck={false}
          placeholder="https://cloud.example.com"
          value={platformUrl}
          disabled={submitting || addressLocked === true}
          aria-invalid={addressError !== null}
          onChange={(event) => {
            setAddressDraft(event.target.value)
            // Why clear-on-type: the message describes the previous value.
            if (addressError !== null) {
              setAddressError(null)
            }
          }}
        />
        {addressError ? (
          <p role="alert" className="text-sm text-destructive">
            {addressError}
          </p>
        ) : null}
        {addressError === null && addressLocked === true ? (
          <p className="text-sm text-muted-foreground">平台地址由企业管理员指定。</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="cloud-username">域账号</Label>
        <Input
          id="cloud-username"
          autoComplete="username"
          autoFocus
          value={username}
          disabled={submitting}
          onChange={(event) => setUsernameDraft(event.target.value)}
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
  )
}
