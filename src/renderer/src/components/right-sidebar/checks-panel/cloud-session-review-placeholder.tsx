import React from 'react'
import { Cloud } from 'lucide-react'
import { translate } from '@/i18n/i18n'

/**
 * The PR area of a cloud session: the host refuses `github.*` because review
 * credentials are host account assets the ticket never carries, so the panel
 * states that scope instead of reading as "this branch has no PR".
 */
export function CloudSessionReviewPlaceholder(): React.JSX.Element {
  return (
    <div className="px-4 py-6" data-cloud-session-review-placeholder>
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Cloud className="size-4 text-muted-foreground" aria-hidden />
        <span>
          {translate(
            'auto.components.right.sidebar.ChecksPanel.cloudSessionReviewTitle',
            'Review integration unavailable'
          )}
        </span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.ChecksPanel.cloudSessionReviewBody',
          'A cloud session does not include pull request integration: review credentials are host account assets, not part of the project ticket.'
        )}
      </div>
    </div>
  )
}
