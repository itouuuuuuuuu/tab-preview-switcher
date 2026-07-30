/**
 * Pure functions behind the switching order. No side effects, so they can be
 * tested on their own.
 *
 * The stack is an array of tab ids, most recent first. Both tabs.onActivated and
 * tabs.onCreated touch it, which is why a tab opened in the background reaches
 * the front without ever having been shown.
 */

/** Maximum number of cards in the overlay, including the current tab. */
export const MAX_CARDS = 5

/** Moves tabId to the front, adding it if it was not there. */
export function touch(stack: readonly number[], tabId: number): number[] {
  return [tabId, ...stack.filter((id) => id !== tabId)]
}

/** Removes tabId from the stack. */
export function drop(stack: readonly number[], tabId: number): number[] {
  return stack.filter((id) => id !== tabId)
}

/**
 * Builds the display ring: the current tab first, then the switching candidates
 * in most-recent-first order.
 *
 * The current tab should already be at the front of the stack, since activation
 * touches it, but right after a tab is created in the background something newer
 * sits above it. In the display the current tab is always pinned first.
 */
export function buildRing(
  stack: readonly number[],
  activeTabId: number,
  limit: number = MAX_CARDS,
): number[] {
  const rest = stack.filter((id) => id !== activeTabId)
  return [activeTabId, ...rest].slice(0, limit)
}

/** Moves focus by delta around the ring. Wraps correctly for negatives too. */
export function step(ringLength: number, index: number, delta: number): number {
  if (ringLength <= 0) return 0
  return (((index + delta) % ringLength) + ringLength) % ringLength
}

/**
 * Search order for a replacement card: recency order minus the tabs already
 * shown and the ones just closed.
 *
 * Returning only the first match is not enough. The chosen tab can be closed or
 * moved to another window right afterwards, so the caller needs to be able to
 * walk down the list.
 */
export function candidatesNotIn(
  ordered: readonly number[],
  exclude: Iterable<number>,
): number[] {
  const excluded = new Set(exclude)
  return ordered.filter((id) => !excluded.has(id))
}

/**
 * Stand-in order for when the stack has not been built yet: the active tab
 * first, then tab strip order. Right after a browser restart there is no way to
 * know the real recency.
 */
export function seedFromTabStrip(
  tabs: readonly { id?: number; active: boolean; index: number }[],
): number[] {
  const ids = [...tabs]
    .sort((a, b) => a.index - b.index)
    .map((t) => t.id)
    .filter((id): id is number => typeof id === 'number')
  const active = tabs.find((t) => t.active)?.id
  return typeof active === 'number' ? touch(ids, active) : ids
}
