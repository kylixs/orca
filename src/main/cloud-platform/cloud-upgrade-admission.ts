import { verifyCloudCredential, type CloudCredentialPayload } from './cloud-credential'

/**
 * Upgrade-time gate for cloud-issued connection credentials.
 *
 * Design §4.3.4 step 1: the host verifies the ticket carried in the
 * `Sec-WebSocket-Protocol` header before the E2EE handshake starts. Rejection is
 * a plain HTTP 401 with an `x-orca-reject` reason — no WebSocket close frame,
 * because no socket exists yet.
 */

export type CloudRevocations = {
  projects?: { id: string; since: number }[]
  users?: { id: string; since: number }[]
  devices?: { id: string; since: number }[]
  jtis?: string[]
}

export type CloudUpgradeHeaders = Record<string, string | string[] | undefined>

export type CloudUpgradeDecision =
  | { ok: true; payload: CloudCredentialPayload }
  | {
      ok: false
      status: 401
      reason: string
      message: string
      /**
       * Carried on the pre-handshake HTTP response (design AC-21): there is no
       * WebSocket close frame before the upgrade succeeds, so the client maps
       * this header to its local error code.
       */
      headers: { 'x-orca-reject': string }
    }

export type CloudUpgradeAdmissionOptions = {
  hostId: string
  hostName: string
  /** kid → SPKI PEM, as served by the platform's /v1/jwks. */
  keys: Map<string, string>
  revocations?: CloudRevocations
  /** Epoch milliseconds. */
  now?: () => number
  clockSkewSeconds?: number
}

export type CloudUpgradeAdmission = (headers: CloudUpgradeHeaders) => CloudUpgradeDecision

const CREDENTIAL_PROTOCOL_PREFIX = 'orca-cred.'
const DEVICE_PUBKEY_HEADER = 'x-orca-device-pubkey'

function headerValue(headers: CloudUpgradeHeaders, name: string): string | null {
  const raw = headers[name]
  if (typeof raw === 'string') {
    return raw
  }
  if (Array.isArray(raw)) {
    return raw[0] ?? null
  }
  return null
}

export function readCloudCredential(protocolHeader: string | null): string | null {
  if (!protocolHeader) {
    return null
  }
  for (const part of protocolHeader.split(',')) {
    const value = part.trim()
    if (value.startsWith(CREDENTIAL_PROTOCOL_PREFIX)) {
      return value.slice(CREDENTIAL_PROTOCOL_PREFIX.length)
    }
  }
  return null
}

function revokedSince(
  entries: { id: string; since: number }[] | undefined,
  id: string
): number | undefined {
  return entries?.find((entry) => entry.id === id)?.since
}

function reject(reason: string, message: string): CloudUpgradeDecision {
  return { ok: false, status: 401, reason, message, headers: { 'x-orca-reject': reason } }
}

/**
 * Decisions are pure: the caller owns replay bookkeeping (`usedJtis`) because it
 * must survive across admission instances (one per transport).
 */
export function createCloudUpgradeAdmission(
  options: CloudUpgradeAdmissionOptions
): CloudUpgradeAdmission {
  const now = options.now ?? Date.now
  const skew = options.clockSkewSeconds ?? 60

  return (headers) => {
    const token = readCloudCredential(headerValue(headers, 'sec-websocket-protocol'))
    if (!token) {
      return reject('credential_missing', '缺少连接凭证。')
    }

    const verdict = verifyCloudCredential(token, options.keys, Math.floor(now() / 1000), skew)
    if (!verdict.ok) {
      return reject(verdict.reason, '连接凭证校验失败。')
    }
    const payload = verdict.payload

    if (payload.host !== options.hostId || payload.aud !== `host:${options.hostName}`) {
      return reject('host_mismatch', '凭证与主机不匹配。')
    }

    const revocations = options.revocations
    const issuedAtMs = payload.iat * 1000
    const projectSince = revokedSince(revocations?.projects, payload.project)
    if (projectSince !== undefined && issuedAtMs <= projectSince) {
      return reject('project_revoked', '项目权限已收回。')
    }
    const userSince = revokedSince(revocations?.users, payload.sub.replace(/^user:/, ''))
    if (userSince !== undefined && issuedAtMs <= userSince) {
      return reject('user_revoked', '用户权限已收回。')
    }
    const deviceSince = revokedSince(revocations?.devices, payload.deviceId)
    if (deviceSince !== undefined && issuedAtMs <= deviceSince) {
      return reject('device_revoked', '该设备已被吊销。')
    }
    if (revocations?.jtis?.includes(payload.jti)) {
      return reject('jti_revoked', '该连接凭证已被吊销。')
    }

    // Fail closed: omitting the header must not bypass the device binding.
    const declaredDevicePubKey = headerValue(headers, DEVICE_PUBKEY_HEADER)
    if (!declaredDevicePubKey) {
      return reject('device_pubkey_missing', '缺少设备公钥。')
    }
    if (!payload.devicePubKey || declaredDevicePubKey !== payload.devicePubKey) {
      return reject('device_mismatch', '凭证与请求设备不匹配。')
    }

    return { ok: true, payload }
  }
}
