/** Structural subset shared by React pointer/mouse events and native DOM events. */
export type TabClosePointerGuardEvent = {
  readonly button: number
  preventDefault(): void
  stopPropagation(): void
}

/**
 * Why: a focused in-tab control hands the gesture to the group's `onFocusCapture`, whose re-render
 * swallows the click (U158/U159). Primary button only, so right/middle clicks stay untouched.
 */
export function guardTabClosePointerDown(event: TabClosePointerGuardEvent): void {
  if (event.button === 0) {
    event.preventDefault()
    event.stopPropagation()
  }
}
