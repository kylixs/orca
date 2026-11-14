// Persistent CA + leaf certificates (and macOS trust) for the local reseed.
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exists, run, tryRun, writeFile } from './local-env-daemon-control.mjs'

function certificate(file) {
  if (!exists(file)) {
    return null
  }
  try {
    return new X509Certificate(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function certUsable(file, caFile, required = {}) {
  const cert = certificate(file)
  if (!cert || Date.parse(cert.validTo) - Date.now() < 14 * 86400_000) {
    return false
  }
  if (caFile) {
    const ca = certificate(caFile)
    if (!ca || !cert.checkIssued(ca) || !cert.verify(ca.publicKey)) {
      return false
    }
  }
  const san = cert.subjectAltName ?? ''
  return (
    (!required.ip || san.includes(`IP Address:${required.ip}`)) &&
    (!required.dns || san.includes(`DNS:${required.dns}`))
  )
}

export const fingerprint = (file) => certificate(file)?.fingerprint256.toLowerCase() ?? null

async function migrate(from, to) {
  if (exists(to) || !exists(from)) {
    return false
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  return true
}

async function ensureCa(paths, log) {
  const movedPem = await migrate('/tmp/m114-platform-tls/ca.pem', paths.caPem)
  const movedKey = await migrate('/tmp/m114-platform-tls/ca.key', paths.caKey)
  if (certUsable(paths.caPem) && exists(paths.caKey)) {
    fs.chmodSync(paths.caKey, 0o600)
    return { source: movedPem || movedKey ? 'migrated' : 'reused', fp: fingerprint(paths.caPem) }
  }
  log('ca', 'generating persistent CA')
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-days',
    '825',
    '-keyout',
    paths.caKey,
    '-out',
    paths.caPem,
    '-subj',
    '/CN=Orca Local Dev CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign'
  ])
  fs.chmodSync(paths.caKey, 0o600)
  return { source: 'generated', fp: fingerprint(paths.caPem) }
}

async function ensureLeaf(paths, name, subject, san, required, legacy, log) {
  const cert = paths[`${name}Cert`]
  const key = paths[`${name}Key`]
  let migrated = false
  if (legacy) {
    const movedCert = await migrate('/tmp/m114-platform-tls/cert.pem', cert)
    const movedKey = await migrate('/tmp/m114-platform-tls/key.pem', key)
    migrated = movedCert || movedKey
  }
  if (exists(key) && certUsable(cert, paths.caPem, required)) {
    fs.chmodSync(key, 0o600)
    return { source: migrated ? 'migrated' : 'reused', fp: fingerprint(cert) }
  }
  log(name, 'issuing certificate')
  const csr = `${cert}.csr`
  const ext = `${cert}.ext`
  await writeFile(
    ext,
    `[v3_leaf]\nsubjectAltName=${san}\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`
  )
  run('openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-keyout',
    key,
    '-out',
    csr,
    '-subj',
    `/CN=${subject}`
  ])
  run('openssl', [
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    paths.caPem,
    '-CAkey',
    paths.caKey,
    '-CAcreateserial',
    '-CAserial',
    paths.caSerial,
    '-out',
    cert,
    '-days',
    '365',
    '-sha256',
    '-extfile',
    ext,
    '-extensions',
    'v3_leaf'
  ])
  fs.chmodSync(key, 0o600)
  fs.rmSync(csr, { force: true })
  fs.rmSync(ext, { force: true })
  return { source: 'issued', fp: fingerprint(cert) }
}

export async function ensureCertificates(paths, options, log) {
  fs.mkdirSync(path.dirname(paths.caPem), { recursive: true })
  const ca = await ensureCa(paths, log)
  const san = `DNS:localhost,IP:127.0.0.1,IP:${options.advertiseHost}`
  const platform = await ensureLeaf(
    paths,
    'platform',
    'orca-cloud-platform',
    san,
    { ip: '127.0.0.1' },
    true,
    log
  )
  const host = await ensureLeaf(
    paths,
    'host',
    options.hostName,
    `${san},DNS:${options.hostName}`,
    { ip: options.advertiseHost, dns: options.hostName },
    false,
    log
  )
  return { ca, platform, host }
}

export function ensureKeychain(paths, options) {
  if (options.skipKeychain) {
    return { status: 'skipped' }
  }
  if (process.platform !== 'darwin') {
    return { status: 'not-applicable' }
  }
  const login = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db')
  const manual = `security add-trusted-cert -r trustRoot -k "${login}" "${paths.caPem}"`
  const trusted = () =>
    (tryRun('security', ['verify-cert', '-c', paths.caPem, '-p', 'ssl']) ?? '').includes(
      'certificate verification successful'
    )
  if (trusted()) {
    return { status: 'already-trusted', fp: fingerprint(paths.caPem) }
  }
  try {
    run('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', login, paths.caPem])
  } catch (error) {
    return { status: 'failed', error: String(error.message).slice(0, 300), manualCommand: manual }
  }
  return trusted()
    ? { status: 'trusted', fp: fingerprint(paths.caPem) }
    : { status: 'failed', manualCommand: manual }
}
