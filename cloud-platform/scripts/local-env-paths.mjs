// On-disk layout of the persistent local environment: platform, CA, and two hosts.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

export function buildPaths(root, options) {
  const p = (name) => path.join(root, name)
  const hostPaths = (dir, certDir, logName, pidName, name, wsPort, projectKeys) => ({
    name,
    wsPort,
    projectKeys,
    home: p(`${dir}/home`),
    ud: p(`${dir}/ud`),
    projects: p(`${dir}/projects`),
    credential: p(`${dir}/ud/orca-cloud-host.json`),
    cert: p(`tls/${certDir}/cert.pem`),
    key: p(`tls/${certDir}/key.pem`),
    log: p(`logs/${logName}`),
    pid: p(`run/${pidName}`)
  })
  return {
    root,
    caPem: p('tls/ca.pem'),
    caKey: p('tls/ca.key'),
    caSerial: p('tls/ca.srl'),
    platformCert: p('tls/platform/cert.pem'),
    platformKey: p('tls/platform/key.pem'),
    supervisor: p('bin/host-supervisor.mjs'),
    forwarderScript: p('bin/forwarder.mjs'),
    logs: p('logs'),
    run: p('run'),
    platformPid: p('run/platform.pid'),
    forwarderPid: p('run/forwarder.pid'),
    platformLog: p('logs/platform.log'),
    forwarderLog: p('logs/forwarder.log'),
    evidence: path.join(ROOT, 'cloud-platform/evidence/env-persist-2026-11-14/result.json'),
    multiHostEvidence: path.join(
      ROOT,
      'cloud-platform/evidence/env-persist-2026-11-14/multi-host.json'
    ),
    hosts: [
      hostPaths('host', 'host', 'host.log', 'host.pid', options.hostName, undefined, [
        'demo-app',
        'zhangsan-demo'
      ]),
      hostPaths(
        'host2',
        'host2',
        'host2.log',
        'host2.pid',
        options.host2Name,
        options.host2WsPort,
        ['infra-tools', 'zhangsan-lab']
      )
    ]
  }
}
