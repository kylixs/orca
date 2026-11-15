import { defineMethod } from '../core'
import { SelectorPath } from './browser-schemas'

/**
 * U66 C2 (R-03): the one registered download RPC records its own outcome —
 * host-attested, so the audit can call a download "host-confirmed". Page-initiated
 * `will-download` never passes through here and stays out of scope (§3.2-3).
 */
export const BROWSER_DOWNLOAD_METHOD = defineMethod({
  name: 'browser.download',
  permission: 'workspace',
  params: SelectorPath,
  handler: async (params, { runtime, cloud, cloudAuditReport, pairedDeviceId }) => {
    try {
      const result = await runtime.browserDownload(params)
      if (cloud) {
        cloudAuditReport?.({
          eventType: 'file_download',
          result: 'success',
          deviceId: pairedDeviceId,
          projectId: cloud.projectId,
          method: 'browser.download',
          metadata: {
            kind: 'browser',
            capturePoint: 'host-browser-download',
            captureConfidence: 'host-attested'
          }
        })
      }
      return result
    } catch (error) {
      if (cloud) {
        cloudAuditReport?.({
          eventType: 'file_download',
          result: 'failure',
          deviceId: pairedDeviceId,
          projectId: cloud.projectId,
          method: 'browser.download',
          reason: 'download_failed',
          metadata: {
            kind: 'browser',
            capturePoint: 'host-browser-download',
            captureConfidence: 'host-attested'
          }
        })
      }
      throw error
    }
  }
})
