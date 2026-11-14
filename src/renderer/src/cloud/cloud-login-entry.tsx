import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from '@/components/status-bar/status-bar-context-menu-policy'
import { translate } from '@/i18n/i18n'
import { CLOUD_LOGIN_DESCRIPTION, CLOUD_LOGIN_TITLE, CloudLoginForm } from './cloud-login-panel'
import type { CloudSessionView } from './use-cloud-session'

/**
 * The native shell's permanent cloud-platform entry (FR-2.7, W11 revision) as an
 * in-flow status bar segment. The bar's own row is what keeps the promise that
 * cloud UI never floats over (or steals clicks from) a native control, and it
 * stays clear of the toast corner. Signed out the segment offers the login
 * dialog; signed in it shows the account and the way out. Without the shell's
 * cloud session provider (browser admin page, Orca Web) it renders nothing.
 */

type CloudLoginEntryContextValue = {
  session: CloudSessionView
  signedIn: boolean
  requestSignOut: () => void
  /** Extra cloud actions sharing the segment row, e.g. the new-project button. */
  leading?: React.ReactNode
}

const CloudLoginEntryContext = React.createContext<CloudLoginEntryContextValue | null>(null)

export function CloudLoginEntryProvider({
  session,
  requestSignOut,
  leading,
  children
}: {
  session: CloudSessionView
  requestSignOut: () => void
  leading?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const value = React.useMemo<CloudLoginEntryContextValue>(
    () => ({
      session,
      signedIn: session.status === 'signed-in',
      requestSignOut,
      ...(leading ? { leading } : {})
    }),
    [session, requestSignOut, leading]
  )
  return <CloudLoginEntryContext.Provider value={value}>{children}</CloudLoginEntryContext.Provider>
}

export function useCloudLoginEntry(): CloudLoginEntryContextValue | null {
  return React.useContext(CloudLoginEntryContext)
}

const SEGMENT_BUTTON_CLASS =
  'inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground'

/** One segment among the native ones; never floats, never covers a native control. */
export function CloudLoginStatusSegment(): React.JSX.Element | null {
  const entry = React.useContext(CloudLoginEntryContext)
  const [open, setOpen] = React.useState(false)
  if (!entry) {
    return null
  }
  const { session, signedIn, requestSignOut, leading } = entry

  return (
    <>
      {leading}
      {signedIn ? (
        <>
          <span
            className="max-w-40 truncate text-[11px] text-muted-foreground"
            title={session.displayName ?? undefined}
          >
            {session.displayName}
          </span>
          <button
            type="button"
            {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
            className={SEGMENT_BUTTON_CLASS}
            onClick={requestSignOut}
          >
            {translate('auto.cloud.signOut', '登出')}
          </button>
        </>
      ) : (
        <button
          type="button"
          {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
          className={SEGMENT_BUTTON_CLASS}
          data-cloud-login-entry=""
          onClick={() => setOpen(true)}
        >
          {translate('auto.cloud.login', '登录云端平台')}
        </button>
      )}
      {/* Why derived, not an effect: a successful sign-in closes the dialog by
      leaving the signed-out state, and a failure keeps it open with the error. */}
      <Dialog open={open && !signedIn} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{CLOUD_LOGIN_TITLE}</DialogTitle>
            <DialogDescription>{CLOUD_LOGIN_DESCRIPTION}</DialogDescription>
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
