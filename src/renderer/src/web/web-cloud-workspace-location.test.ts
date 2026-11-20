// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  normalizeWebCloudWorkspaceUrl,
  readWebCloudWorkspaceLocation,
  webCloudWorkspaceLocationError
} from './web-cloud-workspace-location'

describe('web-cloud-workspace-location', () => {
  it('reads api and project, trimming the platform trailing slash', () => {
    expect(
      readWebCloudWorkspaceLocation({
        search: '?api=https%3A%2F%2Fcloud.test%2F&project=proj_1'
      })
    ).toEqual({ apiUrl: 'https://cloud.test', projectId: 'proj_1' })
  })

  it('returns nulls for a pairing-only URL', () => {
    expect(
      readWebCloudWorkspaceLocation({
        search: '?pairing=orca%3A%2F%2Fpair%3Fcode%3Dx'
      })
    ).toEqual({ apiUrl: null, projectId: null })
  })

  it('rewrites the address bar without the handoff hash and keeps unrelated params', () => {
    window.history.replaceState(
      null,
      '',
      '/web-index.html?api=https%3A%2F%2Fcloud.test&embed=1#handoff=secret&project=proj_1'
    )

    normalizeWebCloudWorkspaceUrl({
      apiUrl: 'https://cloud.test',
      projectId: 'proj_1'
    })

    expect(window.location.search).toBe('?api=https%3A%2F%2Fcloud.test&embed=1&project=proj_1')
    expect(window.location.hash).toBe('')
  })

  it('drops project when the URL names none', () => {
    window.history.replaceState(
      null,
      '',
      '/web-index.html?api=https%3A%2F%2Fcloud.test&project=proj_1'
    )

    normalizeWebCloudWorkspaceUrl({
      apiUrl: 'https://cloud.test',
      projectId: null
    })

    expect(readWebCloudWorkspaceLocation(window.location)).toEqual({
      apiUrl: 'https://cloud.test',
      projectId: null
    })
  })

  it('U106-W3: unusable project ids and platform addresses are 404 inputs', () => {
    expect(
      webCloudWorkspaceLocationError({ apiUrl: 'https://cloud.test', projectId: 'proj_1234abcd' })
    ).toBeNull()
    expect(webCloudWorkspaceLocationError({ apiUrl: null, projectId: null })).toBeNull()
    expect(webCloudWorkspaceLocationError({ apiUrl: null, projectId: 'not a project id' })).toBe(
      'invalid-project'
    )
    expect(webCloudWorkspaceLocationError({ apiUrl: null, projectId: 'proj_<script>' })).toBe(
      'invalid-project'
    )
    expect(webCloudWorkspaceLocationError({ apiUrl: 'javascript:alert(1)', projectId: null })).toBe(
      'invalid-api'
    )
    expect(webCloudWorkspaceLocationError({ apiUrl: 'not-a-url', projectId: 'proj_1' })).toBe(
      'invalid-api'
    )
  })
})
