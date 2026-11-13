import { keyPairFromSecretKey } from '../../shared/e2ee-crypto'
import { errorCodeOf } from '../../shared/json-fields'
import { createCloudAuthSession, type CloudAuthTokens } from './cloud-auth-session'
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
  private readonly clientOptions: CloudConnectOptions

  constructor(
    private readonly options: CloudSessionOptions,
    private readonly createClient: CreateCloudClient
  ) {
    // Why one view: every client this login builds must report rotation to the same store.
    this.clientOptions = { ...options, onTokensChanged: this.onTokensChanged }
  }

  /** Rotation hook handed to every auth session this login creates. */
  readonly onTokensChanged = (tokens: CloudAuthTokens): void => {
    this.write(tokens)
  }

  /** Options a manually logging-in client must use so its rotations are persisted. */
  get restoredClientOptions(): CloudConnectOptions {
    return this.clientOptions
  }

  /** After a manual login: remember what a later rotation must write and do the first write. */
  attach(identity: CloudDeviceIdentity, displayName: string): void {
    this.identity = identity
    this.displayName = displayName
    if (identity.auth.refreshToken !== null) {
      this.write({
        accessToken: identity.auth.accessToken,
        refreshToken: identity.auth.refreshToken
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
    const client = this.createClient(this.clientOptions, identity)
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
