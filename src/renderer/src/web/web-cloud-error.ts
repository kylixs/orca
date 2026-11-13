/** Platform error codes and local failures surface in the same `code` slot. */
export const WEB_CLOUD_ERROR_CODE = {
  malformedReply: 'malformed_reply',
  noEndpoint: 'no_endpoint',
  deviceKeyInvalid: 'device_key_invalid',
  network: 'network_error',
  sessionExpired: 'SESSION_EXPIRED'
} as const

export class WebCloudSessionError extends Error {
  readonly code: string
  readonly status: number | null

  constructor(code: string, message: string, status: number | null = null) {
    super(message)
    this.name = 'WebCloudSessionError'
    this.code = code
    this.status = status
  }
}

/** The refresh token is dead; every later request belongs to a signed-out session. */
export function webCloudSessionExpiredError(): WebCloudSessionError {
  return new WebCloudSessionError(
    WEB_CLOUD_ERROR_CODE.sessionExpired,
    '会话已失效，请重新登录。',
    401
  )
}
