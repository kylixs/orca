import { describe, expect, it } from 'vitest'
import { electronViteConfig } from '../../electron.vite.config'

/**
 * W10 B-1 regression guard: `ORCA_DEFAULT_PLATFORM_URL` and `ORCA_MANAGED_BUILD`
 * must be defined for every electron-vite target that reads them. electron-vite
 * merges each target's config separately, so a define that lives only on `main`
 * leaves the free identifiers in the preload bundle and a build-injected cloud
 * install never exposes window.api.cloud. The built bundles themselves are
 * audited after every build by verify-cloud-build-defines.mjs.
 */

describe('electron-vite 云端构建常量注入', () => {
  it('两个云端常量同时覆盖 main 与 preload 目标', () => {
    for (const target of ['main', 'preload'] as const) {
      const define = electronViteConfig[target]?.define ?? {}
      // 常量必须折叠为字面量：地址是 JSON 字符串或 null，托管开关是布尔字面量。
      expect(define.ORCA_DEFAULT_PLATFORM_URL, `${target}.ORCA_DEFAULT_PLATFORM_URL`).toMatch(
        /^null$|^".*"$/
      )
      expect(define.ORCA_MANAGED_BUILD, `${target}.ORCA_MANAGED_BUILD`).toMatch(/^(true|false)$/)
    }
  })
})
