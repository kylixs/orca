import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileHtmlOpenMode } from './mobile-file-actions'
import {
  resolveMobileHtmlPreviewMode,
  type MobileHtmlOpenMode,
  type MobileHtmlPreviewMode
} from './mobile-html-open-mode'
import { normalizeMobileFilePreviewLineColumn } from './mobile-file-preview-line-column'
import type { MobileFilePreviewRouteParams } from './mobile-file-preview-route'
import { loadMobileHtmlOpenMode, saveMobileHtmlOpenMode } from '../storage/preferences'

/**
 * Page-local HTML mode state. Precedence is resolved from the real route, line target, truncation
 * and stored preference; a manual choice then owns the mode for this page's lifetime and no later
 * preference read can override it. Manual toggles never write the preference, which is what keeps
 * returning from the preview side-effect free.
 */
export function useMobileFilePreviewHtmlMode(args: {
  params: MobileFilePreviewRouteParams | null
  htmlFile: boolean
  terminalArtifact: boolean
  truncated: boolean
  readFailed: boolean
}) {
  const { params, htmlFile, terminalArtifact, truncated, readFailed } = args
  const hasLineTarget = useMemo(
    () => Boolean(normalizeMobileFilePreviewLineColumn(params?.line, params?.column)),
    [params?.column, params?.line]
  )
  const source = terminalArtifact ? ('terminalArtifact' as const) : ('worktree' as const)
  const routeMode = params?.mode
  const [preference, setPreference] = useState<MobileHtmlOpenMode | null>(null)
  const [manualMode, setManualMode] = useState<FileHtmlOpenMode | null>(null)
  const [chooserDismissed, setChooserDismissed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // A route mode, line target, terminal artifact, truncated or failed read already decides; an
  // unreadable file needs no preference either. Only a bare, readable route consults storage.
  useEffect(() => {
    if (!htmlFile || terminalArtifact || routeMode || hasLineTarget || truncated || readFailed) {
      return
    }
    let active = true
    void loadMobileHtmlOpenMode().then((stored) => {
      if (active) {
        setPreference(stored)
      }
    })
    return () => {
      active = false
    }
  }, [hasLineTarget, htmlFile, readFailed, routeMode, terminalArtifact, truncated])

  // A bare route cannot default to Preview while storage is unread: the JS-enabled frame must not
  // mount until the stored mode resolves, or a stored Source would flash the rendered page.
  const preferencePending =
    htmlFile &&
    !terminalArtifact &&
    !routeMode &&
    !hasLineTarget &&
    !truncated &&
    !readFailed &&
    preference === null
  const resolved = resolveMobileHtmlPreviewMode({
    source,
    routeMode,
    hasLineTarget,
    truncated,
    readFailed,
    preference: preference ?? 'ask'
  })
  const mode: FileHtmlOpenMode =
    truncated || readFailed
      ? 'source'
      : (manualMode ?? (preferencePending ? 'source' : resolved === 'ask' ? 'preview' : resolved))
  const sheetVisible =
    !truncated &&
    !readFailed &&
    manualMode === null &&
    !chooserDismissed &&
    preference !== null &&
    resolved === 'ask'

  const chooseMode = useCallback((next: MobileHtmlPreviewMode) => {
    setManualMode(next)
  }, [])

  const selectMode = useCallback(
    (next: MobileHtmlPreviewMode, remember: boolean) => {
      const effective = next === 'preview' && truncated ? 'source' : next
      chooseMode(effective)
      if (!remember) {
        return
      }
      void saveMobileHtmlOpenMode(effective).catch(() => {
        setNotice('Could not save HTML open mode. Try again.')
      })
    },
    [chooseMode, truncated]
  )

  const closeSheet = useCallback(() => {
    // A preference read that lands after dismissal must not reopen or override the chooser.
    setChooserDismissed(true)
  }, [])

  return {
    mode,
    setMode: chooseMode,
    sheetVisible,
    closeSheet,
    notice,
    setNotice,
    selectMode
  }
}
