/**
 * Global hold on tab drags, owned by the drag surfaces and read by the layout catch-up.
 * A counter, not a boolean: two pointers (or nested drag roots) can overlap, and one
 * gesture finishing must not clear the other's hold.
 */
let activeGestureCount = 0

export function beginTabDragGesture(): void {
  activeGestureCount += 1
}

export function endTabDragGesture(): void {
  activeGestureCount = Math.max(0, activeGestureCount - 1)
}

export function isTabDragGestureActive(): boolean {
  return activeGestureCount > 0
}

export function resetTabDragGestureRegistryForTests(): void {
  activeGestureCount = 0
}
