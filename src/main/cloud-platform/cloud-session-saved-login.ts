import { keyPairFromSecretKey } from '../../shared/e2ee-crypto'
import { errorCodeOf } from '../../shared/json-fields'
import { stripCloudUrlUserinfo } from '../../shared/cloud-service-url'
import { createCloudAuthSession, type CloudAuthTokens } from './cloud-auth-session'
import { writeCloudLoginMemory } from './cloud-login-memory'
import type {
  CloudConnectClient,
  CloudConnectOptions,
  CloudDeviceIdentity,
  CloudProject
} from './cloud-connect-client'
import type { CloudSessionOptions, CreateCloudClient } from './cloud-project-connections'
import {
  deletePersistedCloudSession,
  readPersistedCloudSession,
  writePersistedCloudSession
} from './cloud-session-persistence'

/**
 * The desktop login at rest. Restores it on boot, writes every rotated token pair
 * (the old refresh token is spent once the platform rotates), and removes it on
 * sign-out or a dead session. Device identity is reused so the host's binding holds.
 */

export type SavedLoginRestore =
  | { kind: 'none' | 'expired' | 'failed' }
  | { kind: 'ready'; client: CloudConnectClient; displayName: string; projects: CloudProject[] }

export class CloudSessionSavedLogin {
  private displayName: string | null = null
  private identity: CloudDeviceIdentity | null = null

  constructor(
    private readonly options: CloudSessionOptions,
    private readonly createClient: CreateCloudClient
  ) {}

  /** Rotation hook handed to every auth session this login creates. */
  readonly onTokensChanged = (tokens: CloudAuthTokens): void => {
    this.write(tokens)
  }

  /**
   * Options a manually logging-in client must use so its rotations are persisted.
   * Why read live: a login that committed its own platform address re-points the
   * shared options object, and this client must target the new address.
   */
  get restoredClientOptions(): CloudConnectOptions {
    return { ...this.options, onTokensChanged: this.onTokensChanged }
  }

  /**
   * Starts a login, honouring the platform address the user typed (M119/W10):
   * the request targets it, while the shared session options keep the old
   * address until the sign-in succeeded (`commitLoginAddress`) — a failed login
   * must not leave the session pointed at a platform it never reached. The typed
   * value is credential-stripped because a `user:pass@` paste would otherwise
   * reach the login memory verbatim. An address-less client with no typed one is
   * a bug in the caller, not a request worth sending.
   */
  beginLogin(platformUrl?: string): { options: CloudConnectOptions; apiUrl: string } {
    const apiUrl = stripCloudUrlUserinfo(platformUrl?.trim() || '') || this.options.apiUrl
    if (!apiUrl) {
      // Why the message is the code: Electron drops custom error properties at
      // the IPC boundary, and the renderer maps the surviving message to copy.
      throw Object.assign(new Error('PLATFORM_ADDRESS_REQUIRED'), {
        code: 'PLATFORM_ADDRESS_REQUIRED'
      })
    }
    return { options: { ...this.restoredClientOptions, apiUrl }, apiUrl }
  }

  /** Re-points the shared session options once the sign-in actually succeeded. */
  commitLoginAddress(apiUrl: string): void {
    this.options.apiUrl = apiUrl
  }

  /** After a manual login: remember what a later rotation must write and do the first write. */
  attach(identity: CloudDeviceIdentity, displayName: string, username: string): void {
    this.identity = identity
    this.displayName = displayName
    if (identity.auth.refreshToken !== null) {
      this.write({
        accessToken: identity.auth.accessToken,
        refreshToken: identity.auth.refreshToken
      })
    }
    // Why here: the login succeeded, so this is the {address, username} the form
    // prefills next launch — kept even when sign-out later clears the session.
    if (this.options.userDataPath) {
      writeCloudLoginMemory(this.options.userDataPath, {
        platformUrl: this.options.apiUrl,
        username
      })
    }
  }

  clear(): void {
    this.identity = null
    this.displayName = null
    if (this.options.userDataPath) {
      deletePersistedCloudSession(this.options.userDataPath)
    }
  }

  async restore(): Promise<SavedLoginRestore> {
    const userDataPath = this.options.userDataPath
    if (!userDataPath) {
      return { kind: 'none' }
    }
    const persisted = readPersistedCloudSession(userDataPath, this.options.apiUrl)
    if (!persisted) {
      return { kind: 'none' }
    }
    const auth = createCloudAuthSession({
      apiUrl: this.options.apiUrl,
      accessToken: persisted.accessToken,
      refreshToken: persisted.refreshToken,
      fetchImpl: this.options.fetchImpl ?? fetch,
      ...(this.options.refreshLeadMs === undefined
        ? {}
        : { refreshLeadMs: this.options.refreshLeadMs }),
      onTokensChanged: this.onTokensChanged
    })
    // Why the saved secret: the platform and every host ticket bind this device key.
    const keyPair = keyPairFromSecretKey(Buffer.from(persisted.deviceSecretKeyB64, 'base64'))
    const identity: CloudDeviceIdentity = { auth, deviceId: persisted.deviceId, keyPair }
    const client = this.createClient(this.restoredClientOptions, identity)
    this.identity = identity
    this.displayName = persisted.displayName
    try {
      const projects = await client.listProjects()
      // Covers a rotation that happened before the display name was known.
      if (auth.refreshToken !== null) {
        this.write({ accessToken: auth.accessToken, refreshToken: auth.refreshToken })
      }
      return { kind: 'ready', client, displayName: persisted.displayName, projects }
    } catch (error) {
      client.close()
      this.identity = null
      this.displayName = null
      if (errorCodeOf(error) === 'SESSION_EXPIRED') {
        deletePersistedCloudSession(userDataPath)
        return { kind: 'expired' }
      }
      // Why keep the file: a transient failure must not force a fresh login.
      console.warn('[cloud] session restore failed:', errorCodeOf(error) ?? 'network_error')
      return { kind: 'failed' }
    }
  }

  private write(tokens: CloudAuthTokens): void {
    const userDataPath = this.options.userDataPath
    if (!userDataPath || !this.identity || this.displayName === null) {
      return
    }
    const saved = writePersistedCloudSession(userDataPath, {
      version: 1,
      apiUrl: this.options.apiUrl,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      deviceId: this.identity.deviceId,
      deviceSecretKeyB64: Buffer.from(this.identity.keyPair.secretKey).toString('base64'),
      displayName: this.displayName,
      savedAtMs: Date.now()
    })
    if (!saved) {
      // Why warn only: the request that triggered rotation already succeeded.
      console.warn('[cloud] failed to persist the cloud session')
    }
  }
}
