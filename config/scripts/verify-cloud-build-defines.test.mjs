import { describe, expect, it } from 'vitest'
import { auditCloudDefineBundles } from './verify-cloud-build-defines.mjs'

/**
 * W10 B-1: the cloud build constants must be substituted in the bundles of both
 * electron-vite targets that read them. electron-vite merges each target's
 * config separately, so a define that only covers `main` leaves the free
 * identifiers in preload — the exposure predicate then never shows the login
 * screen of a build-injected cloud install, while every test stays green
 * because tests stub the constants through a module seam.
 */

const MAIN_BUNDLE = 'var t="https://baked.example.com"==null?null:"https://baked.example.com"'
const PRELOAD_BUNDLE = 'if(typeof "https://baked.example.com"!=="undefined"){exposeCloud()}'

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
      ),
      expect.stringContaining('no preload bundle contains the build-injected platform address')
    ])
  })

  it('both guarded constants are checked', () => {
    const problems = auditCloudDefineBundles({
      mainBundleCodes: { 'index.js': 'x=typeof ORCA_MANAGED_BUILD!=="undefined"' },
      preloadBundleCodes: { 'index.js': PRELOAD_BUNDLE },
      bakedDefaultUrl: null
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('ORCA_MANAGED_BUILD')
  })

  it('a baked platform address must land in both targets', () => {
    expect(
      auditCloudDefineBundles({
        mainBundleCodes: { 'index.js': MAIN_BUNDLE },
        preloadBundleCodes: { 'index.js': 'var a=1' },
        bakedDefaultUrl: 'https://baked.example.com'
      })
    ).toEqual([
      expect.stringContaining('no preload bundle contains the build-injected platform address')
    ])
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
