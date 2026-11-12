import { readArray, readNumber, readString } from '../../shared/json-fields'
import { parseCloudPolicies, type CloudPolicies } from './cloud-policies'

/** Response shapes the host accepts from the platform's key and policy endpoints. */

export type PlatformSigningKey = { kid: string; publicKeyPem: string }

export function parseKeys(value: unknown): PlatformSigningKey[] {
  return (readArray(value, 'keys') ?? []).flatMap((item) => {
    const kid = readString(item, 'kid')
    const publicKeyPem = readString(item, 'publicKeyPem')
    return kid !== null && publicKeyPem !== null ? [{ kid, publicKeyPem }] : []
  })
}

export type PolicyResponse = { policies: CloudPolicies; version: number | null }

/**
 * `/v1/internal/policy` body. Null when the pack is not understood, so the caller
 * keeps the previous one instead of reopening exports on a truncated reply.
 */
export function parsePolicyResponse(value: unknown): PolicyResponse | null {
  const policies = parseCloudPolicies(value)
  return policies === null ? null : { policies, version: readNumber(value, 'version') }
}
