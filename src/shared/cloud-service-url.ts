export function cleanCloudServiceUrl(
  value: string | undefined,
  allowLoopbackHttp: boolean
): string | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed = new URL(trimmed)
    const loopbackHost =
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '[::1]'
    if (
      parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && loopbackHost && allowLoopbackHttp)
    ) {
      return null
    }
    // Why strip instead of reject: a pasted `user:pass@` host still names the
    // platform the user meant, sign-in never reads URL credentials, and keeping
    // them would write the password into the login memory file.
    parsed.username = ''
    parsed.password = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/** Drops `user:pass@` from a URL string; anything unparsable comes back unchanged. */
export function stripCloudUrlUserinfo(value: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.username === '' && parsed.password === '') {
      return value
    }
    parsed.username = ''
    parsed.password = ''
    // Why the same trailing-slash trim as cleanCloudServiceUrl: both produce the
    // address that gets stored, so they must agree on its shape.
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return value
  }
}

export function cleanCloudServiceOrigin(
  value: string | undefined,
  allowLoopbackHttp: boolean
): string | null {
  const cleaned = cleanCloudServiceUrl(value, allowLoopbackHttp)
  if (!cleaned) {
    return null
  }
  const parsed = new URL(cleaned)
  return parsed.pathname === '/' && !parsed.search && !parsed.hash ? parsed.origin : null
}
