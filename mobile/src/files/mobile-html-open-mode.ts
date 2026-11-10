/**
 * HTML open modes, and the one place their precedence is decided.
 *
 * `ask` is a stored preference and never an open mode; the resolver returns it to say the mode
 * chooser still has to be shown.
 */
export type MobileHtmlOpenMode = 'ask' | 'preview' | 'source'

export type MobileHtmlPreviewMode = Exclude<MobileHtmlOpenMode, 'ask'>

export const DEFAULT_MOBILE_HTML_OPEN_MODE: MobileHtmlOpenMode = 'ask'

export function isMobileHtmlOpenMode(value: unknown): value is MobileHtmlOpenMode {
  return value === 'ask' || value === 'preview' || value === 'source'
}

export function isMobileHtmlPreviewMode(value: unknown): value is MobileHtmlPreviewMode {
  return value === 'preview' || value === 'source'
}

/**
 * The order is normative (design 8.4): an unrenderable file always wins over an explicit route,
 * and a line target wins over the stored preference so the reader lands on the pinned line.
 */
export function resolveMobileHtmlPreviewMode(args: {
  source: 'worktree' | 'terminalArtifact'
  routeMode?: MobileHtmlPreviewMode
  hasLineTarget: boolean
  truncated: boolean
  readFailed: boolean
  preference: MobileHtmlOpenMode
}): MobileHtmlOpenMode {
  if (args.source === 'terminalArtifact') {
    return 'source'
  }
  if (args.truncated || args.readFailed) {
    return 'source'
  }
  if (args.routeMode) {
    return args.routeMode
  }
  if (args.hasLineTarget) {
    return 'source'
  }
  if (isMobileHtmlPreviewMode(args.preference)) {
    return args.preference
  }
  return 'ask'
}
