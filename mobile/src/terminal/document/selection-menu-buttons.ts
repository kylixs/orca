import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'
import { cancelSelect, selectAllTerminal } from './selection-range'

export function startSelectionMenuButtons(scope: TerminalDocumentScope) {
  scope.btnCopy!.addEventListener('click', function (e) {
    e.preventDefault()
    e.stopPropagation()
    if (!scope.term) {
      return
    }
    const text = scope.term.getSelection ? scope.term.getSelection() : ''
    if (text && text.length > 0) {
      notify(scope, { type: 'selection', text: text })
    } else {
      cancelSelect(scope)
    }
  })
  scope.btnSelAll!.addEventListener('click', function (e) {
    e.preventDefault()
    e.stopPropagation()
    selectAllTerminal(scope)
  })
}
