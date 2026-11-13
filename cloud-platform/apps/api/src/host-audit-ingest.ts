import type { AuditChain } from './audit.ts'

/**
 * A host's own refusals, delivered on its heartbeat (design §5.1). The host is
 * the only thing that can see a pre-handshake rejection, so without this the
 * platform audit chain records nothing about forged or stolen tickets.
 *
 * Everything here is best effort: one malformed report or a broken audit chain
 * must not fail the heartbeat the host depends on for revocation and policy.
 */

const MAX_REPORTS_PER_BEAT = 100
const MAX_TEXT_LENGTH = 512

export type HostAuditReport = {
  eventType: 'connection_rejected' | 'path_denied' | 'method_denied'
  result: 'success' | 'failure' | 'denied'
  deviceId?: string
  subject?: string
  projectId?: string
  method?: string
  denial?: string
  reason?: string
}

function isEventType(value: string): value is HostAuditReport['eventType'] {
  return value === 'connection_rejected' || value === 'path_denied' || value === 'method_denied'
}

function isResult(value: string): value is HostAuditReport['result'] {
  return value === 'success' || value === 'failure' || value === 'denied'
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  return value.slice(0, MAX_TEXT_LENGTH)
}

/** An entry is all-or-nothing: a partially understood refusal is not an audit record. */
function parseReport(value: unknown): HostAuditReport | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const field = (key: string): unknown => Reflect.get(value, key)
  const eventType = text(field('eventType'))
  const result = text(field('result'))
  if (!eventType || !isEventType(eventType) || !result || !isResult(result)) {
    return null
  }
  return {
    eventType,
    result,
    deviceId: text(field('deviceId')),
    subject: text(field('subject')),
    projectId: text(field('projectId')),
    method: text(field('method')),
    denial: text(field('denial')),
    reason: text(field('reason'))
  }
}

export function parseHostAuditReports(value: unknown): HostAuditReport[] {
  if (!Array.isArray(value)) {
    return []
  }
  const reports: HostAuditReport[] = []
  for (const entry of value.slice(0, MAX_REPORTS_PER_BEAT)) {
    const parsed = parseReport(entry)
    if (parsed) {
      reports.push(parsed)
    }
  }
  return reports
}

/** Returns how many reports reached the chain; the host clears the whole batch either way. */
export function appendHostAuditReports(
  audit: AuditChain,
  host: { id: string; name: string },
  reports: readonly HostAuditReport[],
  traceId: string
): number {
  let appended = 0
  for (const report of reports) {
    const ok = audit.appendBestEffort({
      eventType: `host.${report.eventType}`,
      actor: `host:${host.name}`,
      targetType: report.deviceId ? 'device' : 'host',
      targetId: report.deviceId ?? host.id,
      result: report.result,
      traceId,
      metadata: {
        ...(report.subject ? { subject: report.subject } : {}),
        ...(report.projectId ? { projectId: report.projectId } : {}),
        ...(report.method ? { method: report.method } : {}),
        ...(report.denial ? { denial: report.denial } : {}),
        ...(report.reason ? { reason: report.reason } : {})
      }
    })
    appended += ok ? 1 : 0
  }
  return appended
}
