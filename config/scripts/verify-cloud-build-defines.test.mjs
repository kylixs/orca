import { describe, expect, it } from 'vitest'
import { auditCloudDefineBundles } from './verify-cloud-build-defines.mjs'

/**
 * W10 B-1, semantics updated by W11: main owns the cloud constants (the address
 * resolution lives in cloud-build-flags.ts), so a build-injected platform
 * address has to land in the main bundle. The preload exposes the bridge
 * unconditionally and no longer reads the constants, so it must not demand the
 * literal — but if any bundle ever carries an unsubstituted `typeof` read (a
 * define that stopped covering its target), the gate must go red.
 */

const MAIN_BUNDLE = 'var t="https://baked.example.com"==null?null:"https://baked.example.com"'
const PRELOAD_BUNDLE = 'const api={cloud:exposure()}'

describe('auditCloudDefineBundles', () => {
  it('substituted bundles pass with no findings', () => {
    expect(
      auditCloudDefineBundles({
        mainBundleCodes: { 'index.js': MAIN_BUNDLE },
        preloadBundleCodes: { 'index.js': PRELOAD_BUNDLE },
        bakedDefaultUrl: 'https://baked.example.com'
      })
    ).toEqual([])
  })

  it('a preload without the baked address passes: the entry is unconditional now (W11)', () => {
    expect(
      auditCloudDefineBundles({
        mainBundleCodes: { 'index.js': MAIN_BUNDLE },
        preloadBundleCodes: { 'index.js': PRELOAD_BUNDLE },
        bakedDefaultUrl: 'https://baked.example.com'
      })
    ).toEqual([])
  })

  it('an unsubstituted typeof read in any target is a finding', () => {
    const problems = auditCloudDefineBundles({
      mainBundleCodes: { 'index.js': MAIN_BUNDLE },
      preloadBundleCodes: {
        'index.js':
          'if(typeof ORCA_DEFAULT_PLATFORM_URL!=="undefined"){return ORCA_DEFAULT_PLATFORM_URL}'
      },
      bakedDefaultUrl: 'https://baked.example.com'
    })
    expect(problems).toEqual([
      expect.stringContaining(
        'preload/index.js still reads the unsubstituted constant ORCA_DEFAULT_PLATFORM_URL'
      )
    ])
  })

  it('negative control: a main define gap leaves the free identifier and drops the address', () => {
    const problems = auditCloudDefineBundles({
      mainBundleCodes: {
        'index.js':
          'if(typeof ORCA_DEFAULT_PLATFORM_URL!=="undefined"){return ORCA_DEFAULT_PLATFORM_URL}'
      },
      preloadBundleCodes: { 'index.js': PRELOAD_BUNDLE },
      bakedDefaultUrl: 'https://baked.example.com'
    })
    expect(problems).toEqual([
      expect.stringContaining(
        'main/index.js still reads the unsubstituted constant ORCA_DEFAULT_PLATFORM_URL'
      ),
      expect.stringContaining('no main bundle contains the build-injected platform address')
    ])
  })

  it('both guarded constants are checked in every target', () => {
    const problems = auditCloudDefineBundles({
      mainBundleCodes: { 'index.js': 'x=typeof ORCA_MANAGED_BUILD!=="undefined"' },
      preloadBundleCodes: { 'index.js': 'y=typeof ORCA_MANAGED_BUILD!=="undefined"' },
      bakedDefaultUrl: null
    })
    expect(problems).toHaveLength(2)
    for (const problem of problems) {
      expect(problem).toContain('ORCA_MANAGED_BUILD')
    }
  })

  it('a baked platform address must land in the main bundle', () => {
    expect(
      auditCloudDefineBundles({
        mainBundleCodes: { 'index.js': 'var a=1' },
        preloadBundleCodes: { 'index.js': PRELOAD_BUNDLE },
        bakedDefaultUrl: 'https://baked.example.com'
      })
    ).toEqual([
      expect.stringContaining('no main bundle contains the build-injected platform address')
    ])
  })

  it('a build without an injected address only checks substitution', () => {
    expect(
      auditCloudDefineBundles({
        mainBundleCodes: { 'index.js': 'var a=1' },
        preloadBundleCodes: { 'index.js': 'var a=1' },
        bakedDefaultUrl: null
      })
    ).toEqual([])
  })
})
