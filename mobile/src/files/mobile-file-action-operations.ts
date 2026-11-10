import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { DOWNLOAD_CHUNK_BYTES } from './mobile-file-download-cache'

const statSchema = z.looseObject({
  size: z.number().int().nonnegative(),
  isDirectory: z.boolean(),
  mtime: z.number().finite(),
  ctime: z.number().finite().optional()
})

const chunkSchema = z.looseObject({
  contentBase64: z
    .string()
    .max((DOWNLOAD_CHUNK_BYTES * 4) / 3)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  bytesRead: z.number().int().min(0).max(DOWNLOAD_CHUNK_BYTES),
  eof: z.boolean()
})

export const fileActionStatRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.action-stat',
    method: 'files.stat',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('file-action-stat', statSchema)
  })
)

export const fileActionChunkRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.action-chunk',
    method: 'files.readChunk',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('file-action-chunk', chunkSchema)
  })
)

export type MobileFileActionRpcSender = MobileFilePreviewRpcSender
