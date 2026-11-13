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
  registerProjects: () => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.registerProjects),
  retryPrepare: (projectId) => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.retryPrepare, projectId),
  createProject: (input) => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.createProject, input),
  archiveProject: (projectId) => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.archiveProject, projectId),
  listProvisionableHosts: () => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.listProvisionableHosts),
  closeProject: (projectId) => ipcRenderer.invoke(CLOUD_PLATFORM_IPC.closeProject, projectId),
  rpc: (method, params, projectId) =>
    ipcRenderer.invoke(CLOUD_PLATFORM_IPC.rpc, method, params, projectId),
  onConnectionChanged: (listener) => {
    const handler = (_event: unknown, payload: CloudConnectionEvent): void => listener(payload)
    ipcRenderer.on(CLOUD_PLATFORM_IPC.connectionChanged, handler)
    return () => ipcRenderer.removeListener(CLOUD_PLATFORM_IPC.connectionChanged, handler)
  }
}
