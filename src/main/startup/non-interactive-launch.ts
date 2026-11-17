import {
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue
} from 'electron'

type LaunchEnv = Readonly<Record<string, string | undefined>>

/**
 * True when this process must never present a blocking native dialog: background
 * automation, headless E2E, an explicit suppression request, or a Node-mode Electron helper.
 */
export function isNonInteractiveLaunch(env: LaunchEnv = process.env): boolean {
  return (
    env.ORCA_BACKGROUND_LAUNCH === '1' ||
    env.ORCA_E2E_HEADLESS === '1' ||
    env.ORCA_SUPPRESS_DIALOGS === '1' ||
    env.ELECTRON_RUN_AS_NODE === '1'
  )
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0]
}

function logSuppressed(label: string): void {
  console.warn(`[dialogs] suppressed: ${firstLine(label)}`)
}

/**
 * Shows a message box unless the launch is non-interactive, where it logs and
 * answers with `nonInteractiveResponse` (the first button by default).
 */
export async function showUserMessageBox(
  options: MessageBoxOptions,
  parentWindow?: BrowserWindow,
  nonInteractiveResponse = 0
): Promise<MessageBoxReturnValue> {
  if (isNonInteractiveLaunch()) {
    logSuppressed(options.title ?? options.message)
    return { response: nonInteractiveResponse, checkboxChecked: false }
  }
  return parentWindow
    ? dialog.showMessageBox(parentWindow, options)
    : dialog.showMessageBox(options)
}

/** Shows a startup error box unless the launch is non-interactive, where it only logs. */
export function showUserErrorBox(title: string, message: string): void {
  if (isNonInteractiveLaunch()) {
    logSuppressed(`${title}: ${message}`)
    return
  }
  dialog.showErrorBox(title, message)
}
