import * as React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { CloudLoginForm } from './cloud-login-panel'
import type { CloudSessionView } from './use-cloud-session'

/**
 * The native shell's permanent cloud-platform entry (FR-2.7, W11 revision):
 * a sign-in chip in every build — including dev with no environment variables —
 * that opens the login dialog. Signed in, the chip shows the account and the
 * way out. Purely additive: it never hides or replaces a native surface.
 */

export function CloudLoginEntry({
  session,
  leading,
  onSignOut
}: {
  session: CloudSessionView
  /** Signed-in extras that share this corner, e.g. the new-project button. */
  leading?: React.ReactNode
  /** Retires the signed-in account's repos before the session itself ends. */
  onSignOut: () => Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const signedIn = session.status === 'signed-in'

  const handleSignOut = (): void => {
    // Why reset here: the dialog state outlives the signed-in stretch, and a
    // stale `open` would pop the form back up the moment the account leaves.
    setOpen(false)
    void (async () => {
      await onSignOut()
      await session.signOut()
    })()
  }

  return (
    <>
      <div
        className="fixed bottom-3 right-3 z-40 flex items-center gap-2"
        data-cloud-login-entry=""
      >
        {leading}
        {signedIn ? (
          <>
            <span
              className="max-w-40 truncate text-xs text-muted-foreground"
              title={session.displayName ?? undefined}
            >
              {session.displayName}
            </span>
            <Button variant="outline" size="xs" onClick={handleSignOut}>
              {translate('auto.cloud.signOut', '登出')}
            </Button>
          </>
        ) : (
          <Button variant="outline" size="xs" onClick={() => setOpen(true)}>
            {translate('auto.cloud.login', '登录云端平台')}
          </Button>
        )}
      </div>
      {/* Why derived, not an effect: a successful sign-in closes the dialog by
      leaving the signed-out state, and a failure keeps it open with the error. */}
      <Dialog open={open && !signedIn} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>登录云端开发平台</DialogTitle>
            <DialogDescription>使用公司域账号登录后选择项目。</DialogDescription>
          </DialogHeader>
          <CloudLoginForm
            submitting={session.status === 'signing-in'}
            error={session.error}
            notice={session.notice}
            defaultPlatformUrl={session.loginContext?.platformUrl ?? null}
            defaultUsername={session.loginContext?.username ?? null}
            addressLocked={session.loginContext?.locked ?? false}
            onSignIn={(username, password, platformUrl) =>
              void session.signIn(username, password, platformUrl)
            }
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
