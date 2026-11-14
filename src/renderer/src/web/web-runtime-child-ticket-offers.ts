import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { WebPairingOffer } from './web-pairing'

/**
 * Signs the upgrade ticket one more connection needs. A cloud ticket is spent by
 * the client's own upgrade, so a stream's child socket presents a freshly signed
 * one; legacy offers upgrade without a ticket and never call this.
 */
export type WebRuntimeTicketReSigner = () => Promise<WebPairingOffer>

/**
 * Which offer each child connection dials with. A cloud ticket is single-use and
 * this client's own upgrade spent it, so a child signs a fresh one; without a
 * signer the upgrade could only ever be refused as a replay.
 */
export class WebRuntimeChildTicketOffers {
  private reSigner: WebRuntimeTicketReSigner | null

  constructor(reSigner: WebRuntimeTicketReSigner | null = null) {
    this.reSigner = reSigner
  }

  get hasReSigner(): boolean {
    return this.reSigner !== null
  }

  /** Attach ticket signing once; the connect flow adopts the client with its session. */
  attachReSigner(reSigner: WebRuntimeTicketReSigner): void {
    if (this.reSigner) {
      return
    }
    this.reSigner = reSigner
  }

  async offerForNextConnection(signal?: AbortSignal): Promise<WebPairingOffer> {
    const reSigner = this.reSigner
    if (!reSigner) {
      throw new Error(
        'This cloud connection used up its one-time ticket; a stream needs a freshly signed one.'
      )
    }
    const offer = await waitForPromiseWithSignal(reSigner(), signal)
    throwIfSignalAborted(signal)
    return offer
  }
}
