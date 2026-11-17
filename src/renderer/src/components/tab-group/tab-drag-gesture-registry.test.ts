import { afterEach, describe, expect, it } from 'vitest'
import {
  beginTabDragGesture,
  endTabDragGesture,
  isTabDragGestureActive,
  resetTabDragGestureRegistryForTests
} from './tab-drag-gesture-registry'

afterEach(() => {
  resetTabDragGestureRegistryForTests()
})

describe('tab drag gesture registry', () => {
  it('stays active while any concurrent gesture is held', () => {
    beginTabDragGesture()
    beginTabDragGesture()
    expect(isTabDragGestureActive()).toBe(true)

    endTabDragGesture()
    expect(isTabDragGestureActive()).toBe(true)

    endTabDragGesture()
    expect(isTabDragGestureActive()).toBe(false)
  })

  it('ignores an extra end so a stray release cannot clear another gesture', () => {
    beginTabDragGesture()
    endTabDragGesture()
    endTabDragGesture()

    expect(isTabDragGestureActive()).toBe(false)

    beginTabDragGesture()
    expect(isTabDragGestureActive()).toBe(true)
  })
})
