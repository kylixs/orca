import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCloudHostTls, tlsCertificateFingerprint } from './cloud-host-tls'

/**
 * M108: the fingerprint the platform publishes must identify the certificate the
 * host actually serves, and a half-configured host must fail loudly rather than
 * advertise `wss://` on a plain listener.
 */

function makeCert(): { certPath: string; keyPath: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-host-tls-'))
  const keyPath = join(dir, 'server.key')
  const certPath = join(dir, 'server.crt')
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=host-tls-test',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ])
  return { certPath, keyPath, cert: readFileSync(certPath, 'utf8') }
}

describe('云端宿主 TLS', () => {
  it('M108-1 指纹按 DER 计算：换行与 PEM 重新编码都不影响结果', () => {
    const { cert } = makeCert()
    const crlf = cert.replace(/\n/g, '\r\n')
    const fingerprint = tlsCertificateFingerprint(cert)
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(tlsCertificateFingerprint(crlf)).toBe(fingerprint)
  })

  it('M108-2 两项都配置才返回证书；只配一项直接报错', () => {
    const { certPath, keyPath, cert } = makeCert()
    const resolved = resolveCloudHostTls({
      ORCA_CLOUD_TLS_CERT_PATH: certPath,
      ORCA_CLOUD_TLS_KEY_PATH: keyPath
    })
    expect(resolved?.cert).toBe(cert)
    expect(resolved?.fingerprint).toBe(tlsCertificateFingerprint(cert))
    expect(resolveCloudHostTls({})).toBeNull()
    expect(() => resolveCloudHostTls({ ORCA_CLOUD_TLS_CERT_PATH: certPath })).toThrow(
      /must be set together/
    )
  })
})
