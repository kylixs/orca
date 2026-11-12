import type { IncomingMessage } from 'node:http'
import { headerText } from './http-header-text'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { remoteRuntimeUpgradeRejectionMessage } from './remote-runtime-connect-bound'

/**
 * The cloud gate rejects before the handshake, and `ws` reports that as a bare
 * error; without the header the reason (`replayed`, `device_revoked`) is lost.
 */
export function upgradeRejectionError(response: IncomingMessage): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError(
    'remote_runtime_unavailable',
    remoteRuntimeUpgradeRejectionMessage(
      response.statusCode ?? 0,
      headerText(response.headers['x-orca-reject'])
    )
  )
}
