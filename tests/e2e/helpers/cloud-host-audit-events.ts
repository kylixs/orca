import { readArray, readField, readString } from './cloud-platform-stack'

/** One host-reported refusal as the platform's audit chain stores it. */
export type HostMethodDenial = {
  method: string | null
  denial: string | null
  reason: string | null
  projectId: string | null
}

/**
 * Reads the platform's chain of host-reported `method_denied` events. Reports
 * ride the host's heartbeat, so a refusal that just happened may not be here
 * yet — assertions on "an event arrived" must poll, and assertions on "none
 * happened" should read twice with a settle in between.
 */
export async function fetchHostMethodDenials(
  platformUrl: string,
  adminToken: string
): Promise<HostMethodDenial[]> {
  const reply = await fetch(`${platformUrl}/v1/audit/events?eventType=host.method_denied`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  if (reply.status !== 200) {
    throw new Error(`audit query failed: ${reply.status} ${await reply.clone().text()}`)
  }
  const events = readArray(await reply.json(), 'events') ?? []
  return events.map((event) => {
    const metadata = readField(event, 'metadata')
    return {
      method: readString(metadata, 'method'),
      denial: readString(metadata, 'denial'),
      reason: readString(metadata, 'reason'),
      projectId: readString(metadata, 'projectId')
    }
  })
}

/** Groups denials by RPC method name, keeping first-seen order. */
export function countDenialsByMethod(denials: HostMethodDenial[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const denial of denials) {
    const method = denial.method ?? '<none>'
    counts[method] = (counts[method] ?? 0) + 1
  }
  return counts
}
