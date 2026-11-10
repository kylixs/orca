export type HtmlOpenActionId = 'preview' | 'source'

export type HtmlOpenAction = {
  id: HtmlOpenActionId
  label: string
}

/**
 * The one input the HTML mode actions are derived from (design 8.3). Route and line-target state
 * choose the initial mode; they never remove a mode the reader may switch to, so they are not part
 * of this availability question.
 */
export type HtmlOpenActionState = {
  source: 'worktree' | 'terminalArtifact'
  previewDisabled: boolean
  readFailed: boolean
}

const HTML_OPEN_ACTION_LABELS: Record<HtmlOpenActionId, string> = {
  preview: 'Preview',
  source: 'Source'
}

/**
 * HTML uses its mode Preview in place of the generic file Preview, followed by Source.
 *
 * A terminal artifact is source-only but still exposes that one visible mode action, which is what
 * lets the caller open it directly; a failed read leaves neither mode actionable.
 */
export function availableHtmlOpenActions(state: HtmlOpenActionState): HtmlOpenAction[] {
  if (state.readFailed) {
    return []
  }
  if (state.source === 'terminalArtifact') {
    return [{ id: 'source', label: HTML_OPEN_ACTION_LABELS.source }]
  }
  const actions: HtmlOpenAction[] = []
  if (!state.previewDisabled) {
    actions.push({ id: 'preview', label: HTML_OPEN_ACTION_LABELS.preview })
  }
  actions.push({ id: 'source', label: HTML_OPEN_ACTION_LABELS.source })
  return actions
}
