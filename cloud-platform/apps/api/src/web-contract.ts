import {
  MIN_WEB_CONTRACT_VERSION,
  WEB_CONTRACT_VERSION
} from './web-release.ts'

/**
 * A frontend released earlier than the API still calls the endpoints it was
 * built against (AC-19). Saying so explicitly beats a blank page: the console
 * declares its contract in `x-orca-web-contract` and an unsupported one gets a
 * machine-readable 426 it can explain, never a silent 404.
 *
 * The header is optional — a frontend that predates it sends nothing and is
 * treated as current, because dropping it would defeat the compatibility window.
 */

export type WebContractCheck =
  | { ok: true; offered: number }
  | { ok: false; offered: number | null; min: number; max: number }

export function readWebContract(headers: Record<string, string | string[] | undefined>): number | null {
  const raw = headers['x-orca-web-contract']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.NaN
}

export function checkWebContract(offeredHeader: number | null): WebContractCheck {
  if (offeredHeader === null) {
    return { ok: true, offered: WEB_CONTRACT_VERSION }
  }
  if (Number.isNaN(offeredHeader) || offeredHeader < MIN_WEB_CONTRACT_VERSION || offeredHeader > WEB_CONTRACT_VERSION) {
    return {
      ok: false,
      offered: Number.isNaN(offeredHeader) ? null : offeredHeader,
      min: MIN_WEB_CONTRACT_VERSION,
      max: WEB_CONTRACT_VERSION
    }
  }
  return { ok: true, offered: offeredHeader }
}
