import { AlertTriangle, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export type WebCloudWorkspaceErrorKind = 'forbidden' | 'not-found'

type WebCloudWorkspaceErrorProps = {
  kind: WebCloudWorkspaceErrorKind
  /** Platform address used to offer the project list; null keeps the page self-contained. */
  apiUrl?: string | null
}

/** A malformed `api` must never become a clickable `javascript:` link. */
function platformProjectsUrl(apiUrl: string | null): string | null {
  if (!apiUrl) {
    return null
  }
  try {
    const url = new URL(apiUrl)
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? `${apiUrl.replace(/\/+$/, '')}/#/projects`
      : null
  } catch {
    return null
  }
}

/**
 * U106-W3: a named project the account cannot open (403) and a malformed address
 * (404) are terminal page states, not sign-in prompts. The URL is left untouched
 * so a refresh repeats the same verdict; the way out is the platform's project list.
 */
export default function WebCloudWorkspaceError({
  kind,
  apiUrl = null
}: WebCloudWorkspaceErrorProps): React.JSX.Element {
  const forbidden = kind === 'forbidden'
  const projectsUrl = platformProjectsUrl(apiUrl)
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-6 text-foreground">
      <div
        role="alert"
        data-testid={`web-cloud-workspace-error-${kind}`}
        className="flex w-full max-w-[520px] flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-sm"
      >
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 text-destructive">
            <AlertTriangle size={18} aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-semibold leading-6">
              {forbidden
                ? translate('auto.web.WebConnect.projectForbiddenTitle', 'This project cannot be opened')
                : translate('auto.web.WebConnect.pageNotFoundTitle', 'Page not found')}
            </h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {forbidden
                ? translate(
                    'auto.web.WebConnect.projectForbiddenDetail',
                    'The project does not exist, or your account does not have permission to open it. Your address was kept; return to the platform to pick another project.'
                  )
                : translate(
                    'auto.web.WebConnect.pageNotFoundDetail',
                    'The project or platform address in this link is not valid. It may be an outdated or mistyped link.'
                  )}
            </p>
          </div>
        </div>

        {projectsUrl ? (
          <Button asChild variant="outline" className="self-start">
            <a href={projectsUrl}>
              <ArrowLeft size={15} aria-hidden />
              {translate(
                'auto.web.WebConnect.backToProjects',
                'Back to the platform and pick another project'
              )}
            </a>
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.web.WebConnect.reopenFromPlatform',
              'Open the project again from the platform.'
            )}
          </p>
        )}
      </div>
    </div>
  )
}
