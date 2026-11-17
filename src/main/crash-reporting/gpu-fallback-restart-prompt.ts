import type { BrowserWindow, MessageBoxOptions } from 'electron'
import { showUserMessageBox } from '../startup/non-interactive-launch'

export type GpuFallbackRestartDecision = 'restart' | 'continue'

const GPU_FALLBACK_RESTART_OPTIONS: MessageBoxOptions = {
  type: 'warning',
  buttons: ['Restart in Safe Graphics Mode', 'Keep Running'],
  defaultId: 0,
  cancelId: 1,
  title: 'Restart Orca in Safe Graphics Mode?',
  message: "Orca's graphics process has crashed repeatedly.",
  detail:
    'Safe graphics mode disables hardware acceleration and WebGL for this Orca version. Terminals and 3D content may render more slowly. Keep Running leaves graphics settings unchanged.'
}

export async function promptForGpuFallbackRestart(
  parentWindow?: BrowserWindow
): Promise<GpuFallbackRestartDecision> {
  // Non-interactive launches answer the cancel button ("Keep Running") and keep defaults.
  const { response } = await showUserMessageBox(GPU_FALLBACK_RESTART_OPTIONS, parentWindow, 1)
  return response === 0 ? 'restart' : 'continue'
}
