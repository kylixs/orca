import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * Design §5.3: every upgrade that carries a connect credential is TLS, internal
 * networks included. The platform hands clients `wss://` addresses, so a cloud
 * host must serve its runtime socket over TLS and tell the platform which
 * certificate clients should see.
 */

export type CloudHostTls = {
  cert: string
  key: string
  /** `sha256:<hex>` over the certificate DER — the value the platform publishes. */
  fingerprint: string
}

/** SHA-256 of the DER body; PEM re-encoding and line endings cannot change it. */
export function tlsCertificateFingerprint(certPem: string): string {
  return derCertificateFingerprint(new X509Certificate(certPem).raw)
}

/** The form the platform publishes and the client compares the live cert against. */
export function derCertificateFingerprint(der: Buffer): string {
  return `sha256:${createHash('sha256').update(der).digest('hex')}`
}

/** Legacy platforms publish a fallback name here; only real fingerprints pin. */
export function isSha256Fingerprint(value: string | undefined): value is string {
  return value !== undefined && /^sha256:[0-9a-f]{64}$/.test(value)
}

/**
 * Reads the host's certificate and key. Both must be present: a host that has
 * only one of them would advertise `wss://` on a plain listener, which is exactly
 * the mismatch this module exists to prevent.
 */
export function resolveCloudHostTls(env: NodeJS.ProcessEnv = process.env): CloudHostTls | null {
  const certPath = env.ORCA_CLOUD_TLS_CERT_PATH
  const keyPath = env.ORCA_CLOUD_TLS_KEY_PATH
  if (!certPath && !keyPath) {
    return null
  }
  if (!certPath || !keyPath) {
    throw new Error(
      'Cloud host TLS is incomplete: ORCA_CLOUD_TLS_CERT_PATH and ORCA_CLOUD_TLS_KEY_PATH must be set together'
    )
  }
  const cert = readFileSync(certPath, 'utf8')
  const key = readFileSync(keyPath, 'utf8')
  return { cert, key, fingerprint: tlsCertificateFingerprint(cert) }
}
