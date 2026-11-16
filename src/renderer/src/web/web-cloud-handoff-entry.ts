import { useCallback, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { adoptWebRuntimeClient } from './preload-api/web-runtime-session'
import type { WebCloudAuthTokens } from './web-cloud-auth'
import {
  createLocalStorageWebCloudDeviceKey,
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceIdentity,
  type WebCloudDeviceKeyStorage
} from './web-cloud-device-key'
import {
  createBrowserWebCloudSessionStorage,
  readPersistedWebCloudSession,
  writePersistedWebCloudSession,
  type WebCloudSessionStorage
} from './web-cloud-session-storage'
import {
  redeemWebHandoff,
  WEB_CLOUD_ERROR_CODE,
  WebCloudSessionError,
  type WebCloudSession
} from './web-cloud-session'
import {
  connectCloudProjectWithSession,
  WEB_CLOUD_CONNECT_ERROR_CODE,
  WebCloudConnectError,
  type WebCloudConnectClient
} from './web-cloud-connect'
import {
  readStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment,
  type StoredWebRuntimeEnvironment
} from './web-runtime-environment'

/**
 * FR-3.10 entry: the platform hands out `<web入口>?api=<平台>#handoff=<code>&project=<id>`,
 * and this module turns that URL into a signed-in workspace — trading the
 * one-time code for a session, then opening the named project. The code rides
 * the hash only, so it is wiped from the address bar before anything else
 * happens (refresh, history, Referer must never see it again).
 */

export type WebCloudHandoffEntry = {
  code: string
  projectId: string
  /** The platform the code must be traded on — the entry URL's `?api=`. */
  apiUrl: string
}

/** Reads the handoff entry out of the address bar, or null when this is not one. */
export function readWebCloudHandoffEntry(location: {
  hash: string
  search: string
}): WebCloudHandoffEntry | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, '').trim())
  const code = (params.get('handoff') ?? '').trim()
  const projectId = (params.get('project') ?? '').trim()
  if (!code || !projectId) {
    return null
  }
  return { code, projectId, apiUrl: readWebCloudApiUrlFromLocation(location) ?? '' }
}

/**
 * The platform address from the entry URL's `?api=`. It is not a secret, so it
 * survives the handoff wipe and pre-fills the sign-in form when no code is left.
 */
export function readWebCloudApiUrlFromLocation(location: { search: string }): string | null {
  const apiUrl = (new URLSearchParams(location.search).get('api') ?? '').trim()
  return apiUrl ? apiUrl.replace(/\/+$/, '') : null
}

/**
 * Why the search stays: `?api=` is an address, not a secret, and it is what the
 * fallback login form pre-fills when the code is spent.
 */
export function clearWebHandoffFromAddressBar(): void {
  if (!window.location.hash) {
    return
  }
  window.history.replaceState(
    null,
    document.title,
    `${window.location.origin}${window.location.pathname}${window.location.search}`
  )
}

/** Maps the exchange/entry failures to the one notice the login form shows. */
export function webCloudHandoffFailureNotice(error: unknown): string {
  if (error instanceof WebCloudSessionError) {
    if (error.code === 'HANDOFF_GONE') {
      return translate(
        'auto.web.WebConnect.handoffGone',
        'This entry link has expired or was already used. Open the project again from the platform.'
      )
    }
    if (error.code === 'PROJECT_FORBIDDEN') {
      return translate(
        'auto.web.WebConnect.handoffForbidden',
        'Your account no longer has access to this project. Sign in to continue.'
      )
    }
    if (error.code === WEB_CLOUD_ERROR_CODE.network) {
      return translate(
        'auto.web.WebConnect.handoffNetwork',
        'The platform cannot be reached. Check the network and sign in again.'
      )
    }
  }
  if (
    error instanceof WebCloudConnectError &&
    error.code === WEB_CLOUD_CONNECT_ERROR_CODE.noProjects
  ) {
    return translate(
      'auto.web.WebConnect.handoffNoProject',
      'This project is not visible to your account. Sign in to continue.'
    )
  }
  return translate(
    'auto.web.WebConnect.handoffFailed',
    'The project could not be opened automatically. Sign in to continue.'
  )
}

export type EnterWorkspaceViaHandoffInput = {
  entry: WebCloudHandoffEntry
  deviceKeyStore: WebCloudDeviceKeyStorage
  sessionStorage: WebCloudSessionStorage
  fetchImpl?: typeof fetch
  now?: () => number
  /** Tests shrink it; production uses `WEB_CLOUD_HANDOFF_ENTRY_TIMEOUT_MS`. */
  timeoutMs?: number
}

export type EnterWorkspaceViaHandoffResult =
  | { status: 'entered'; projectName: string; runtimeId: string }
  | { status: 'failed'; notice: string; apiUrl: string }

/** How long the entry screen waits for the platform before falling back to sign-in. */
export const WEB_CLOUD_HANDOFF_ENTRY_TIMEOUT_MS = 10_000

/** Set when the deadline fires, so the losing flow only unwinds, never touches the page. */
type WebHandoffEntryTimeout = { fired: boolean }

const handoffTimeoutResult = (apiUrl: string): EnterWorkspaceViaHandoffResult => ({
  status: 'failed',
  // A hung platform reads like an unreachable one: back to the sign-in form.
  notice: webCloudHandoffFailureNotice(
    new WebCloudSessionError(WEB_CLOUD_ERROR_CODE.network, 'handoff entry timed out', null)
  ),
  apiUrl
})

/**
 * The whole M122 journey in one call: trade the code, persist the session, open
 * the named project's workspace and hand the live socket to the App. A failure
 * leaves no socket behind — the connect tail closes its own, and an exchange
 * failure never opened one — and the caller falls back to the sign-in form.
 */
async function openWorkspaceViaWebHandoff(
  input: EnterWorkspaceViaHandoffInput,
  timeout: WebHandoffEntryTimeout
): Promise<EnterWorkspaceViaHandoffResult> {
  const { entry } = input
  const failed = (error: unknown): EnterWorkspaceViaHandoffResult => ({
    status: 'failed',
    notice: webCloudHandoffFailureNotice(error),
    apiUrl: entry.apiUrl
  })
  if (!entry.apiUrl) {
    return failed(null)
  }
  let identity: WebCloudDeviceIdentity
  try {
    identity = loadOrCreateWebCloudDeviceKey(input.deviceKeyStore)
  } catch (error) {
    return failed(error)
  }
  const persistTokens = (session: WebCloudSession, tokens: WebCloudAuthTokens): void => {
    writePersistedWebCloudSession(input.sessionStorage, {
      version: 1,
      apiUrl: session.apiUrl,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      deviceId: session.deviceId,
      displayName: session.user.displayName,
      savedAtMs: Date.now()
    })
  }
  let session: WebCloudSession
  try {
    // Why the persisted device id first: one browser is one device row, whether
    // it entered by password or by handoff.
    const knownDeviceId =
      readPersistedWebCloudSession(input.sessionStorage, entry.apiUrl)?.deviceId ?? undefined
    session = await redeemWebHandoff({
      apiUrl: entry.apiUrl,
      code: entry.code,
      devicePublicKeyB64: identity.publicKeyB64,
      deviceName: 'Orca Web',
      ...(knownDeviceId ? { deviceId: knownDeviceId } : {}),
      onTokensChanged: (tokens) => persistTokens(session, tokens),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.now ? { now: input.now } : {})
    })
    if (timeout.fired) {
      // The page already fell back; a late exchange persists and connects nothing.
      return handoffTimeoutResult(entry.apiUrl)
    }
    persistTokens(session, {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken
    })
  } catch (error) {
    return failed(error)
  }
  let client: WebCloudConnectClient
  let environment: StoredWebRuntimeEnvironment
  let projectName: string
  let runtimeId: string
  try {
    const connection = await connectCloudProjectWithSession({
      session,
      devicePublicKeyB64: identity.publicKeyB64,
      deviceSecretKeyB64: identity.secretKeyB64,
      projectId: entry.projectId,
      previousEnvironment: readStoredWebRuntimeEnvironment(),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
    })
    client = connection.client
    environment = connection.environment
    projectName = connection.projectName
    runtimeId = connection.runtimeId
  } catch (error) {
    return failed(error)
  }
  if (timeout.fired) {
    // The page already fell back; close the socket it will never be handed.
    client.close()
    return handoffTimeoutResult(entry.apiUrl)
  }
  try {
    // Why persist before mounting: the App's preload layer reads this record.
    saveStoredWebRuntimeEnvironment(environment)
  } catch (error) {
    client.close()
    return failed(error)
  }
  // Why adopt: the ticket was consumed by the validation probe, so the App must
  // use this exact live socket instead of upgrading the stored offer again.
  adoptWebRuntimeClient(client, environment)
  return { status: 'entered', projectName, runtimeId }
}

/**
 * Races the entry journey against the deadline. Whatever the flow still does
 * after the deadline only unwinds behind the sign-in form (see the `timeout`
 * checks in `openWorkspaceViaWebHandoff`).
 */
export async function enterWorkspaceViaWebHandoff(
  input: EnterWorkspaceViaHandoffInput
): Promise<EnterWorkspaceViaHandoffResult> {
  const timeout: WebHandoffEntryTimeout = { fired: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  const flow = openWorkspaceViaWebHandoff(input, timeout).finally(() => clearTimeout(timer))
  const deadline = new Promise<EnterWorkspaceViaHandoffResult>((resolve) => {
    timer = setTimeout(() => {
      timeout.fired = true
      resolve(handoffTimeoutResult(input.entry.apiUrl))
    }, input.timeoutMs ?? WEB_CLOUD_HANDOFF_ENTRY_TIMEOUT_MS)
  })
  return Promise.race([flow, deadline])
}

export type WebCloudHandoffEntryState =
  | { status: 'idle' }
  | { status: 'entering' }
  | { status: 'failed'; notice: string; apiUrl: string }

const HANDOFF_IDLE: WebCloudHandoffEntryState = { status: 'idle' }

/** Runs the entry flow once per handoff URL and reports the outcome to the root. */
export function useWebCloudHandoffEntry(onEntered: () => void): {
  state: WebCloudHandoffEntryState
  begin: (entry: WebCloudHandoffEntry) => void
} {
  const [state, setState] = useState<WebCloudHandoffEntryState>(HANDOFF_IDLE)
  const onEnteredRef = useRef(onEntered)
  onEnteredRef.current = onEntered
  const begin = useCallback((entry: WebCloudHandoffEntry) => {
    setState({ status: 'entering' })
    enterWorkspaceViaWebHandoff({
      entry,
      deviceKeyStore: createLocalStorageWebCloudDeviceKey(),
      sessionStorage: createBrowserWebCloudSessionStorage()
    })
      .then((result) => {
        if (result.status === 'entered') {
          onEnteredRef.current()
          return
        }
        setState({ status: 'failed', notice: result.notice, apiUrl: result.apiUrl })
      })
      .catch((error: unknown) =>
        setState({
          status: 'failed',
          notice: webCloudHandoffFailureNotice(error),
          apiUrl: entry.apiUrl
        })
      )
  }, [])
  return { state, begin }
}
