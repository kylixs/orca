// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import WebCloudWorkspaceError from './WebCloudWorkspaceError'

afterEach(cleanup)

/** U106-W3: 403/404 are terminal page states that keep the URL and offer the platform. */
describe('WebCloudWorkspaceError', () => {
  it('403 explains the project and returns to the platform project list', () => {
    render(<WebCloudWorkspaceError kind="forbidden" apiUrl="https://cloud.test" />)

    const page = screen.getByTestId('web-cloud-workspace-error-forbidden')
    expect(page.textContent).toContain('This project cannot be opened')
    expect(page.textContent).toContain('permission')
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('https://cloud.test/#/projects')
    expect(link.textContent).toContain('pick another project')
  })

  it('404 explains the malformed address and stays actionable without an api url', () => {
    render(<WebCloudWorkspaceError kind="not-found" />)

    const page = screen.getByTestId('web-cloud-workspace-error-not-found')
    expect(page.textContent).toContain('Page not found')
    expect(page.textContent).toContain('not valid')
    expect(screen.queryByRole('link')).toBeNull()
    expect(page.textContent).toContain('Open the project again from the platform.')
  })

  it('never renders a non-http api url as a link', () => {
    render(<WebCloudWorkspaceError kind="not-found" apiUrl="javascript:alert(1)" />)

    expect(screen.queryByRole('link')).toBeNull()
  })
})
