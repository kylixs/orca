import type * as React from 'react'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import type { CloudFileRendererId, CloudFileRendererProps } from './registry'

/** Shared lazy identity so multi-tab reuse resolves to one chunk load. */
export function lazyRenderer(
  id: CloudFileRendererId,
  load: () => Promise<{ default: React.ComponentType<CloudFileRendererProps> }>
): React.LazyExoticComponent<React.ComponentType<CloudFileRendererProps>> {
  return lazyWithRetry(load, { reloadKey: `cloud.renderer.${id}` })
}
