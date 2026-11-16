import { errorCodeOf } from '../../../shared/json-fields'
import { translate } from '@/i18n/i18n'
import { adoptWebRuntimeClient } from './preload-api/web-runtime-session'
import type { WebCloudAuthTokens } from './web-cloud-auth'
import {
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceKeyStorage
} from './web-cloud-device-key'
import {
  connectCloudProjectWithSession,
  WEB_CLOUD_CONNECT_ERROR_CODE,
  type WebCloudConnectClientFactory,
  type WebCloudProjectConnection
} from './web-cloud-connect'
import {
  createBrowserWebCloudProjectMemoryStorage,
  readRememberedCloudProjectId,
  type WebCloudProjectMemoryStorage
} from './web-cloud-project-memory'
import { restoreWebCloudSession } from './web-cloud-session-restore'
import {
  deletePersistedWebCloudSession,
  readPersistedWebCloudSession,
  writePersistedWebCloudSession,
  type WebCloudSessionStorage
} from './web-cloud-session-storage'
import { WEB_CLOUD_ERROR_CODE } from './web-cloud-error'
import type { WebCloudWorkspaceLocation } from './web-cloud-workspace-location'
import {
  saveStoredWebRuntimeEnvironment,
  type StoredWebRuntimeEnvironment
} from './web-runtime-environment'

/**
 * U103-B1: a reload resumes the saved cloud login instead of demanding a new one.
 * The URL's `project` is authoritative; the remembered project is only a fallback
 * when the URL names none. A dead refresh token clears the saved login, a network
 * failure keeps it, and an unreachable project never silently switches projects.
 */

export type WebCloudSessionResumeResult =
  | {
      status: 'resumed'
      projectId: string
      projectName: string
      runtimeId: string
    }
  | { status: 'no-session' }
  | { status: 'expired' }
  | { status: 'project-unavailable'; code: string; message: string }
  | { status: 'error'; code: string; message: string }

export type ResumeWebCloudSessionInput = {
  location: WebCloudWorkspaceLocation
  storage: WebCloudSessionStorage
  deviceKeyStore: WebCloudDeviceKeyStorage
  projectMemory?: WebCloudProjectMemoryStorage
  previousEnvironment?: StoredWebRuntimeEnvironment | null
  fetchImpl?: typeof fetch
  now?: () => number
  /** Test seams; production wires the real connect/adopt/storage functions. */
  connect?: typeof connectCloudProjectWithSession
  adopt?: (
    client: WebCloudProjectConnection['client'],
    environment: StoredWebRuntimeEnvironment
  ) => void
  saveEnvironment?: (environment: StoredWebRuntimeEnvironment) => void
  clientFactory?: WebCloudConnectClientFactory
  endpointUrl?: string
}

const UNAVAILABLE_CODES = new Set<string>([
  WEB_CLOUD_CONNECT_ERROR_CODE.projectNotVisible,
  WEB_CLOUD_CONNECT_ERROR_CODE.noProjects,
  WEB_CLOUD_CONNECT_ERROR_CODE.noOpenableProjects,
  'PROJECT_FORBIDDEN'
])

function failureOf(error: unknown): WebCloudSessionResumeResult {
  const code = errorCodeOf(error) ?? WEB_CLOUD_CONNECT_ERROR_CODE.connectFailed
  const message = error instanceof Error ? error.message : String(error)
  if (UNAVAILABLE_CODES.has(code)) {
    return { status: 'project-unavailable', code, message }
  }
  return { status: 'error', code, message }
}

export async function resumeWebCloudSession(
  input: ResumeWebCloudSessionInput
): Promise<WebCloudSessionResumeResult> {
  const { apiUrl, projectId } = input.location
  if (!apiUrl) {
    return { status: 'no-session' }
  }
  const persisted = readPersistedWebCloudSession(input.storage, apiUrl)
  if (!persisted) {
    return { status: 'no-session' }
  }
  const projectMemory = input.projectMemory ?? createBrowserWebCloudProjectMemoryStorage()
  const persistTokens = (tokens: WebCloudAuthTokens): void => {
    writePersistedWebCloudSession(input.storage, {
      ...persisted,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      savedAtMs: Date.now()
    })
  }
  const session = restoreWebCloudSession({
    persisted,
    onTokensChanged: persistTokens,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.now ? { now: input.now } : {})
  })
  // Why URL first: an explicit `project` is the page the user is on; memory is a
  // convenience for `?api=`-only URLs, never a substitute for the address bar.
  const rememberedProjectId =
    projectId === null
      ? (readRememberedCloudProjectId(projectMemory, apiUrl) ?? undefined)
      : undefined
  const identity = loadOrCreateWebCloudDeviceKey(input.deviceKeyStore)
  let connection: WebCloudProjectConnection
  try {
    connection = await (input.connect ?? connectCloudProjectWithSession)({
      session,
      devicePublicKeyB64: identity.publicKeyB64,
      deviceSecretKeyB64: identity.secretKeyB64,
      ...(projectId === null ? {} : { projectId }),
      ...(rememberedProjectId === undefined ? {} : { rememberedProjectId }),
      ...(input.previousEnvironment ? { previousEnvironment: input.previousEnvironment } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.clientFactory ? { clientFactory: input.clientFactory } : {}),
      ...(input.endpointUrl ? { endpointUrl: input.endpointUrl } : {})
    })
  } catch (error) {
    if (errorCodeOf(error) === WEB_CLOUD_ERROR_CODE.sessionExpired) {
      // Why clear: a dead refresh token can never make this login usable again.
      deletePersistedWebCloudSession(input.storage)
      return { status: 'expired' }
    }
    return failureOf(error)
  }
  try {
    ;(input.saveEnvironment ?? saveStoredWebRuntimeEnvironment)(connection.environment)
  } catch (error) {
    connection.client.close()
    return failureOf(error)
  }
  ;(input.adopt ?? adoptWebRuntimeClient)(connection.client, connection.environment)
  return {
    status: 'resumed',
    projectId: connection.projectId,
    projectName: connection.projectName,
    runtimeId: connection.runtimeId
  }
}

export function webCloudResumeFailureNotice(result: WebCloudSessionResumeResult): string | null {
  if (result.status === 'expired') {
    return translate(
      'auto.web.WebConnect.cloudSessionExpired',
      'Your cloud session expired. Sign in again to continue.'
    )
  }
  if (result.status === 'project-unavailable') {
    return translate(
      'auto.web.WebConnect.projectUnavailable',
      'This project does not exist or your account cannot open it. Sign in to continue.'
    )
  }
  if (result.status === 'error') {
    return translate(
      'auto.web.WebConnect.resumeNetwork',
      'The platform or host cannot be reached. Your saved sign-in was kept; reload to retry.'
    )
  }
  return null
}
