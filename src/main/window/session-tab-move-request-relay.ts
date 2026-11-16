import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { RuntimeMobileSessionTabMove } from '../../shared/runtime-types'
import type { SessionTabMoveRequest, SessionTabMoveResponse } from '../../shared/session-tab-move'

const SESSION_TAB_MOVE_RESPONSE_TIMEOUT_MS = 5_000

/**
 * Forward a move to the authoritative renderer and resolve whether its store
 * actually applied it. `false` covers renderer-unavailable and timeout, so the
 * RPC can never report a move the window silently dropped.
 */
export async function requestSessionTabMoveFromRenderer(
  mainWindow: BrowserWindow,
  worktreeId: string,
  move: RuntimeMobileSessionTabMove
): Promise<boolean> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return false
  }
  const webContents = mainWindow.webContents
  const requestId = randomUUID()
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (applied: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      ipcMain.removeListener('ui:sessionTabMoveResponse', onResponse)
      mainWindow.removeListener('closed', onRendererUnavailable)
      webContents.removeListener('destroyed', onRendererUnavailable)
      webContents.removeListener('render-process-gone', onRendererUnavailable)
      webContents.removeListener('did-start-loading', onRendererUnavailable)
      resolve(applied)
    }
    const onRendererUnavailable = (): void => finish(false)
    const onResponse = (event: Electron.IpcMainEvent, response: SessionTabMoveResponse): void => {
      if (event.sender !== webContents || response.requestId !== requestId) {
        return
      }
      finish(response.applied === true)
    }
    const timeout = setTimeout(
      () => finish(false),
      SESSION_TAB_MOVE_RESPONSE_TIMEOUT_MS
    )
    timeout.unref?.()
    ipcMain.on('ui:sessionTabMoveResponse', onResponse)
    mainWindow.once('closed', onRendererUnavailable)
    webContents.once('destroyed', onRendererUnavailable)
    webContents.once('render-process-gone', onRendererUnavailable)
    webContents.once('did-start-loading', onRendererUnavailable)
    const request: SessionTabMoveRequest = {
      requestId,
      worktreeId,
      expiresAt: Date.now() + SESSION_TAB_MOVE_RESPONSE_TIMEOUT_MS,
      ...move
    }
    try {
      webContents.send('ui:moveSessionTab', request)
    } catch {
      finish(false)
    }
  })
}
