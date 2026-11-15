import type { CloudSessionState } from '../../../shared/cloud-platform-ipc'
import type { WebCloudAuthTokens } from '../web/web-cloud-auth'
import {
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceIdentity,
  type WebCloudDeviceKeyStorage
} from '../web/web-cloud-device-key'
import {
  listCloudProjects,
  loginToCloud,
  redeemWebHandoff,
  type WebCloudSession
} from '../web/web-cloud-session'
import { summarize } from './cloud-browser-bridge-replies'

/** The two browser entry paths (password and one-time handoff) share one result shape. */
export type CloudSignedIn = {
  session: WebCloudSession
  identity: WebCloudDeviceIdentity
  state: CloudSessionState
}

type SignInBase = {
  apiUrl: string
  deviceName: string
  deviceKeyStore: WebCloudDeviceKeyStorage
  fetchOptions: { fetchImpl?: typeof fetch }
  now?: () => number
  onTokensChanged: (tokens: WebCloudAuthTokens) => void
}

export function signInWithPassword(
  input: SignInBase & { username: string; password: string }
): Promise<CloudSignedIn> {
  const identity = loadOrCreateWebCloudDeviceKey(input.deviceKeyStore)
  return loginToCloud({
    apiUrl: input.apiUrl,
    username: input.username,
    password: input.password,
    devicePublicKeyB64: identity.publicKeyB64,
    deviceName: input.deviceName,
    onTokensChanged: input.onTokensChanged,
    ...input.fetchOptions,
    ...(input.now ? { now: input.now } : {})
  }).then((session) => finish(session, identity, input))
}

export function signInWithHandoff(
  input: SignInBase & { code: string; deviceId?: string }
): Promise<CloudSignedIn> {
  const identity = loadOrCreateWebCloudDeviceKey(input.deviceKeyStore)
  return redeemWebHandoff({
    apiUrl: input.apiUrl,
    code: input.code,
    devicePublicKeyB64: identity.publicKeyB64,
    deviceName: input.deviceName,
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    onTokensChanged: input.onTokensChanged,
    ...input.fetchOptions,
    ...(input.now ? { now: input.now } : {})
  }).then((session) => finish(session, identity, input))
}

/** Both entries list projects before reporting signed-in, exactly like the old login. */
async function finish(
  session: WebCloudSession,
  identity: WebCloudDeviceIdentity,
  input: SignInBase
): Promise<CloudSignedIn> {
  const projects = await listCloudProjects(session, input.fetchOptions)
  return {
    session,
    identity,
    state: {
      status: 'signed-in',
      displayName: session.user.displayName,
      projects: projects.map(summarize)
    }
  }
}
