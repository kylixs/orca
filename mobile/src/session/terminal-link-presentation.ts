/**
 * How a terminal link is described before it is opened.
 *
 * The summary deliberately hides userinfo and the path: a long, credential-bearing URL is both
 * unreadable and a phishing surface. Expanding shows the whole thing, but bidi overrides and
 * control characters are removed first so the rendered text cannot be reordered around the user.
 */

function isBidiOrControl(code: number): boolean {
  return (
    code <= 8 ||
    code === 11 ||
    code === 12 ||
    (code >= 14 && code <= 31) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x61c ||
    code === 0x200e ||
    code === 0x200f ||
    // Zero-width format characters can hide characters inside an otherwise readable URL.
    (code >= 0x200b && code <= 0x200d) ||
    code === 0x2060 ||
    code === 0xfeff ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

export type TerminalLinkPresentation = {
  summary: string
  full: string
  http: boolean
  loopbackOrPrivate: boolean
}

export function sanitizeTerminalLinkText(value: string): string {
  let sanitized = ''
  for (const character of value) {
    if (!isBidiOrControl(character.codePointAt(0)!)) {
      sanitized += character
    }
  }
  return sanitized
}

function parse(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function hostWithoutBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4) {
    return false
  }
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false
  }
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 169 && octets[1] === 254) ||
    octets.every((octet) => octet === 0)
  )
}

function isPrivateIpv6(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return (
    lower === '::1' ||
    lower === '0:0:0:0:0:0:0:1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80:')
  )
}

export function isLoopbackOrPrivateHost(hostname: string): boolean {
  const lowered = hostWithoutBrackets(hostname).toLowerCase()
  if (lowered === 'localhost' || lowered.endsWith('.localhost') || lowered.endsWith('.local')) {
    return true
  }
  if (lowered.includes(':')) {
    return isPrivateIpv6(lowered)
  }
  return isPrivateIpv4(lowered)
}

/**
 * A parse failure must not put the whole URL, userinfo included, in the one-line summary.
 * The scheme is enough to say what kind of link it is; the full value stays in the expanded view.
 */
function unparseableSummary(value: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)
  return scheme ? `${scheme[1]!.toLowerCase()}:…` : 'Unparseable URL'
}

export function presentTerminalLink(url: string): TerminalLinkPresentation {
  const filtered = sanitizeTerminalLinkText(url)
  const parsed = parse(filtered)
  if (!parsed) {
    return {
      summary: unparseableSummary(filtered),
      full: filtered,
      http: false,
      loopbackOrPrivate: false
    }
  }
  // `host` carries the port but never userinfo, which is exactly the summary contract.
  const summary = `${parsed.protocol}//${parsed.host}`
  return {
    summary,
    full: filtered,
    http: parsed.protocol === 'http:',
    loopbackOrPrivate: isLoopbackOrPrivateHost(parsed.hostname)
  }
}

export function terminalLinkWarnings(presentation: TerminalLinkPresentation): string[] {
  const warnings: string[] = []
  if (presentation.http) {
    warnings.push('This link uses unencrypted HTTP.')
  }
  if (presentation.loopbackOrPrivate) {
    warnings.push(
      'Loopback and private addresses usually are not reachable from this phone. If this is an SSH session, the address belongs to the remote host; desktop open uses the desktop Orca browser.'
    )
  }
  return warnings
}
