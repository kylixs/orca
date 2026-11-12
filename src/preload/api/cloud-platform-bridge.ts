import { ipcRenderer } from 'electron'
import { CLOUD_PLATFORM_IPC, type CloudConnectionEvent } from '../../shared/cloud-platform-ipc'
import type { CloudPlatformApi } from './cloud-platform-api'

export const cloudPlatformApi: CloudPlatformApi = {
  login: (username, password) => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.login, username, password),
  logout: () => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.logout),
  getState: () => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.state),
  listProjects: () => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.listProjects),
  openProject: (projectId) => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.openProject, projectId),
  openWorkspace: (projectId) => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.openWorkspace, projectId),
  closeProject: () => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.closeProject),
  rpc: (method, params) => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.rpc, method, params),
  onConnectionChanged: (listener) => {
    const handler = (_event: unknown, payload: CloudConnectionEvent): void => listener(payload)
    ipcRenderer.on(CLOUD_PLATFORM_IPC.connectionChanged, handler)
    return () => ipcRenderer.removeListener(CLOUD_PLATFORM_IPC.connectionChanged, handler)
  }
}
