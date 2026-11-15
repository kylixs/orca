import type { WebSocket } from 'ws'
import type {
  PairingGetEndpointsParams,
  PairingProvisionRelayParams
} from '../../../shared/mobile-relay-credential-contract'
import { fingerprintAuthenticatedPairingCredential } from '../rpc/orchestration-mutation-executor'
import type { AuthenticatedMobileSocket } from '../rpc/mobile-socket-wiring'
import type { RpcRequest, RpcResponse } from '../rpc/core'
import type { WebSocketTransport } from '../rpc/ws-transport'
import type { DeviceScope } from '../device-registry'
import { RuntimeRpcRequestAdmission } from './runtime-rpc-request-admission'
import { classifyRuntimeLongPoll } from './runtime-rpc-long-poll'
import type { RpcCallerScope } from '../rpc/rpc-caller-scope'
import { cloudMethodAccess } from '../../cloud-platform/cloud-rpc-permission'
import { checkCloudRpcPath, isCloudPathGuardedMethod } from '../../cloud-platform/cloud-path-guard'
import { pathDenialDetails } from '../../cloud-platform/cloud-denial-details'
import { limitRuntimeRpcReplySize } from './runtime-rpc-reply-size-limit'

// Why: status.get has no per-connection context in the dispatcher, so stamp the scope here at the transport boundary.
function injectDeviceScope(response: string, scope: DeviceScope): string {
  try {
    const parsed = JSON.parse(response) as RpcResponse
    if (parsed.ok !== true || typeof parsed.result !== 'object' || parsed.result === null) {
      return response
    }
    ;(parsed.result as Record<string, unknown>).deviceScope = scope
    return JSON.stringify(parsed)
  } catch {
    return response
  }
}

export class RuntimeRpcWebSocketDispatch extends RuntimeRpcRequestAdmission {
  // Why: WebSocket dispatch is streaming (multiple responses) and auths via per-device tokens, not the shared token.
  protected async handleWebSocketMessage(
    rawMessage: string,
    reply: (response: string) => void,
    sendBinary: (response: Uint8Array<ArrayBufferLike>) => boolean | void,
    wsTransport?: WebSocketTransport,
    ws?: WebSocket,
    authenticatedDeviceToken?: string | null,
    authenticatedSocket?: AuthenticatedMobileSocket
  ): Promise<void> {
    let request: RpcRequest
    try {
      request = JSON.parse(rawMessage) as RpcRequest
    } catch {
      reply(JSON.stringify(this.buildError('unknown', 'bad_request', 'Invalid JSON request')))
      return
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      reply(JSON.stringify(this.buildError('unknown', 'bad_request', 'Missing request id')))
      return
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      reply(JSON.stringify(this.buildError(request.id, 'bad_request', 'Missing RPC method')))
      return
    }

    const requestToken =
      typeof (request as Record<string, unknown>).deviceToken === 'string'
        ? ((request as Record<string, unknown>).deviceToken as string)
        : null
    if (authenticatedDeviceToken && requestToken && requestToken !== authenticatedDeviceToken) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Device token mismatch')))
      return
    }
    // Why: E2EE already authenticated the channel; authorize by that bound identity, not a repeated request field.
    const token = authenticatedDeviceToken ?? requestToken
    if (!token) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Missing device token')))
      return
    }
    const device = this.deviceRegistry?.validateToken(token)
    if (!device) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Invalid device token')))
      return
    }
    // Why: the dispatcher enforces this scope's permissions; it never trusts a request field.
    // A cloud device carries the platform's signed permission set; it is never
    // granted the paired-runtime UI powers (settings, accounts, host admin).
    // Why before the mobile check: the ticket is the authority for a session the
    // platform admitted, so a row that also says `mobile` (a stale or downgraded
    // registry entry) must not demote the project methods to the phone allowlist —
    // that fallback answers bare `forbidden` with no denial details, which is what
    // stranded the admin workspace's first workspace RPC (W5a evidence).
    const cloudSession = device.cloudSession
    const cloudGuard = this.cloudAccessGuard
    const callerScope: RpcCallerScope = cloudSession
      ? {
          kind: 'cloud',
          permissions: cloudSession.permissions,
          // Unknown policy means export stays closed (design §9.3).
          downloadAllowed: cloudGuard?.downloadAllowed(cloudSession.projectId) ?? false
        }
      : device.scope === 'mobile'
        ? { kind: 'mobile' }
        : { kind: 'runtime-paired', grants: device.grants ?? [] }

    // Why: reads are metered, not blocked (design §9.1) — the client may rebuild a
    // file from the bytes, so the control is accounting plus a spent budget.
    const meteredRead =
      cloudSession !== undefined &&
      cloudGuard !== null &&
      cloudSession.permissions.includes('file:read') &&
      cloudMethodAccess(request.method) === 'file:read'
    if (meteredRead && !cloudGuard.consumeRead(cloudSession.projectId)) {
      const usage = cloudGuard.usage(cloudSession.projectId)
      reply(
        JSON.stringify(
          this.buildError(
            request.id,
            'read_budget_exceeded',
            `Hourly read budget spent for this project (${usage.calls}/${usage.rate.calls} reads, ${usage.bytes}/${usage.rate.bytes} bytes).`
          )
        )
      )
      return
    }

    // Why: bind deviceToken to this socket so ws.on('close') knows which mobile client disconnected.
    if (wsTransport && ws) {
      wsTransport.setClientId(ws, token)
    }

    // Why before long-poll admission: a call outside the session's project must not
    // occupy a slot, and the answer must be the boundary, not a handler error.
    // Why gate on the ticket's own permission: a call that lacks the permission is
    // refused by the dispatcher, and its message ("needs 'file:write'") is the one
    // the user needs — not a path verdict for a call that was never allowed.
    // Git needs `terminal`, files need the matching `file:` permission.
    // `open` is checked like any other permission when the method declares a path
    // rule: repo.add registers the project root and nothing else.
    const cloudAccess = cloudSession === undefined ? null : cloudMethodAccess(request.method)
    const pathChecked =
      cloudSession !== undefined &&
      isCloudPathGuardedMethod(request.method) &&
      cloudAccess !== null &&
      cloudAccess !== 'session' &&
      cloudSession.permissions.includes(cloudAccess)
    if (cloudSession && pathChecked) {
      const pathDecision = await checkCloudRpcPath({
        runtime: this.runtime,
        roots: { projectRoot: cloudSession.projectRoot, workspaceRoot: cloudSession.workspaceRoot },
        method: request.method,
        params: request.params
      })
      if (pathDecision && !pathDecision.ok) {
        this.cloudAuditSink?.({
          eventType: 'path_denied',
          deviceId: device.deviceId,
          subject: device.name,
          projectId: cloudSession.projectId,
          method: request.method,
          denial: 'PATH_OUTSIDE_ROOT',
          reason: pathDecision.reason
        })
        reply(
          JSON.stringify(
            this.buildError(
              request.id,
              'forbidden',
              pathDecision.message,
              pathDenialDetails(pathDecision.reason)
            )
          )
        )
        return
      }
    }

    const longPoll = classifyRuntimeLongPoll(request)
    const rejection = this.admitLongPoll(longPoll, device.deviceId)
    if (rejection) {
      reply(JSON.stringify(this.buildError(request.id, 'runtime_busy', rejection)))
      return
    }

    const abortRegistration = ws ? this.registerWebSocketDispatchAbort(ws) : null

    // Why: older pairings may lack scope metadata, so stamp the authenticated scope onto status.get.
    const boundedReply = limitRuntimeRpcReplySize(request.id, reply, (id, code, message) =>
      this.buildError(id, code, message)
    )
    const replyForRequest = (response: string): void => {
      if (meteredRead) {
        cloudGuard.accountReply(cloudSession.projectId, Buffer.byteLength(response))
      }
      boundedReply(
        request.method === 'status.get' ? injectDeviceScope(response, device.scope) : response
      )
    }

    const connectionId = ws ? this.mobileSocketWiring?.getConnectionId(ws) : undefined
    const pairingProvider = this.mobileRelayPairingProvider
    const pairingContext =
      pairingProvider && authenticatedSocket
        ? {
            getEndpoints: (params: PairingGetEndpointsParams) =>
              pairingProvider.getEndpoints(
                {
                  deviceId: authenticatedSocket.device.deviceId,
                  connectionId: authenticatedSocket.connectionId,
                  transport: authenticatedSocket.transport
                },
                params
              ),
            provisionRelay: (params: PairingProvisionRelayParams) =>
              pairingProvider.provisionRelay(
                {
                  deviceId: authenticatedSocket.device.deviceId,
                  connectionId: authenticatedSocket.connectionId,
                  transport: authenticatedSocket.transport
                },
                params
              )
          }
        : undefined
    try {
      await this.dispatcher.dispatchStreaming(request, replyForRequest, {
        // Why: the validated credential preserves existing federation ownership without trusting request fields.
        authenticatedCallerFingerprint: fingerprintAuthenticatedPairingCredential(token),
        connectionId,
        clientId: token,
        pairedDeviceId: device.deviceId,
        // Why: gates the mobile-only payload diet so full-screen web/desktop clients aren't truncated.
        clientKind: device.scope,
        callerScope,
        // Why the split: a boundary verdict (a frame naming a path outside the
        // ticket) is a path denial; only permission/policy refusals are method
        // denials — except a download-policy refusal, which is the download
        // outcome it blocked (U66 C1): one action, one event, `file_download`
        // denied instead of a `method_denied` alias.
        onCloudDenial: (details, method) =>
          this.cloudAuditSink?.(
            details.denial === 'DOWNLOAD_DISABLED'
              ? {
                  eventType: 'file_download',
                  result: 'denied',
                  deviceId: device.deviceId,
                  // The ticket's sub is already `user:<username>` (§2.1 subject form).
                  subject: device.name,
                  projectId: cloudSession?.projectId,
                  method,
                  denial: details.denial,
                  reason: details.reason,
                  metadata: { captureConfidence: 'host-attested' }
                }
              : {
                  eventType:
                    details.denial === 'PATH_OUTSIDE_ROOT' ? 'path_denied' : 'method_denied',
                  deviceId: device.deviceId,
                  subject: device.name,
                  projectId: cloudSession?.projectId,
                  method,
                  denial: details.denial,
                  reason: details.reason
                }
          ),
        // Why: the client-declared file audit is cloud-only; the method itself
        // answers non-cloud-session when this is absent.
        cloudFileEvent:
          cloudSession && this.cloudFileEventAudit
            ? (report) =>
                this.cloudFileEventAudit!(report, {
                  deviceId: device.deviceId,
                  // The ticket's sub is already `user:<username>` (§2.1 subject form).
                  subject: device.name,
                  projectId: cloudSession.projectId
                })
            : undefined,
        cloudAuditReport: this.cloudAuditSink ?? undefined,
        // Why: the host-only view of the ticket; provisioning must never read a
        // path or URL out of client-supplied params.
        cloud: cloudSession
          ? {
              projectId: cloudSession.projectId,
              projectRoot: cloudSession.projectRoot,
              workspaceRoot: cloudSession.workspaceRoot,
              repoUrl: cloudSession.repoUrl ?? '',
              defaultBranch: cloudSession.defaultBranch ?? '',
              // Copy: the registry row's array must not alias a handler-visible reply.
              perms: [...cloudSession.permissions]
            }
          : undefined,
        // Why: the handler only asks this server to queue the outcome; it never
        // reports to the platform itself.
        cloudReportProvision: (report) => this.cloudProvisionReporter?.(report),
        clientCapabilities: authenticatedSocket?.clientCapabilities,
        updateClientCapabilities:
          authenticatedSocket && device.scope === 'mobile'
            ? (clientCapabilities) => {
                authenticatedSocket.clientCapabilities = clientCapabilities
              }
            : undefined,
        pairing: pairingContext,
        signal: abortRegistration?.signal,
        sendBinary,
        registerBinaryStreamHandler: (streamId, handler) =>
          this.registerBinaryStreamHandler(connectionId, streamId, handler),
        registerBinaryMessageHandler: (handler) =>
          this.registerBinaryMessageHandler(connectionId, handler)
      })
    } finally {
      abortRegistration?.dispose()
      this.releaseLongPoll(longPoll, device.deviceId)
    }
  }
}
