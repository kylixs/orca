// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CloudSessionReviewPlaceholder } from './cloud-session-review-placeholder'

describe('CloudSessionReviewPlaceholder', () => {
  afterEach(() => cleanup())

  it('states the cloud scope instead of reading as "no pull request"', () => {
    render(<CloudSessionReviewPlaceholder />)
    expect(screen.getByText('Review integration unavailable')).toBeTruthy()
    expect(
      screen.getByText(
        'A cloud session does not include pull request integration: review credentials are host account assets, not part of the project ticket.'
      )
    ).toBeTruthy()
    expect(document.querySelector('[data-cloud-session-review-placeholder]')).not.toBeNull()
  })
})
