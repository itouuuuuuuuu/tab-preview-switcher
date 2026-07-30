import { describe, expect, it } from 'vitest'
import { buildRing, candidatesNotIn, drop, seedFromTabStrip, step, touch } from './recency'

describe('touch', () => {
  it('moves the tab to the front', () => {
    expect(touch([1, 2, 3], 3)).toEqual([3, 1, 2])
  })

  it('adds an unknown tab id', () => {
    expect(touch([1, 2], 9)).toEqual([9, 1, 2])
  })

  it('leaves the stack alone when the tab is already first', () => {
    expect(touch([1, 2, 3], 1)).toEqual([1, 2, 3])
  })

  it('never creates duplicates', () => {
    expect(touch(touch([1, 2, 3], 2), 2)).toEqual([2, 1, 3])
  })
})

describe('drop', () => {
  it('removes the tab', () => {
    expect(drop([1, 2, 3], 2)).toEqual([1, 3])
  })

  it('does nothing when the tab is absent', () => {
    expect(drop([1, 2], 9)).toEqual([1, 2])
  })
})

describe('buildRing', () => {
  it('pins the current tab first', () => {
    expect(buildRing([3, 1, 2], 1)).toEqual([1, 3, 2])
  })

  it('cuts off at MAX_CARDS', () => {
    expect(buildRing([1, 2, 3, 4, 5, 6, 7], 1)).toEqual([1, 2, 3, 4, 5])
  })

  it('accepts an explicit limit', () => {
    expect(buildRing([1, 2, 3, 4], 1, 3)).toEqual([1, 2, 3])
  })

  it('yields a single element when there is only one tab', () => {
    expect(buildRing([1], 1)).toEqual([1])
  })

  it('puts the current tab first even when it is missing from the stack', () => {
    expect(buildRing([2, 3], 1)).toEqual([1, 2, 3])
  })
})

describe('the scenario from the spec', () => {
  it('opening three links in the background from tab A makes the last one, D, the first candidate', () => {
    const A = 1
    let stack = touch([], A) // A is activated.
    stack = touch(stack, 2) // B created in the background.
    stack = touch(stack, 3) // C created in the background.
    stack = touch(stack, 4) // D created in the background.

    expect(stack).toEqual([4, 3, 2, 1])
    expect(buildRing(stack, A)).toEqual([A, 4, 3, 2])
  })

  it('committing to D puts D at the front, so A becomes the first candidate again', () => {
    let stack = [4, 3, 2, 1]
    stack = touch(stack, 4) // D is activated.
    expect(buildRing(stack, 4)).toEqual([4, 3, 2, 1])

    stack = touch(stack, 1) // Back to A.
    expect(buildRing(stack, 1)).toEqual([1, 4, 3, 2])
  })

  it('drops closed tabs from the candidates', () => {
    let stack = [4, 3, 2, 1]
    stack = drop(stack, 3)
    expect(buildRing(stack, 1)).toEqual([1, 4, 2])
  })
})

describe('candidatesNotIn', () => {
  it('excludes while preserving recency order', () => {
    expect(candidatesNotIn([5, 4, 3, 2, 1], [3, 1])).toEqual([5, 4, 2])
  })

  it('returns every match, not just the first, so the caller can walk down', () => {
    expect(candidatesNotIn([9, 8, 7], [])).toEqual([9, 8, 7])
  })

  it('accepts a Set', () => {
    expect(candidatesNotIn([3, 2, 1], new Set([2]))).toEqual([3, 1])
  })

  it('returns nothing when everything is excluded', () => {
    expect(candidatesNotIn([1, 2], [1, 2])).toEqual([])
  })

  it('surfaces the sixth tab once four shown and one closed are excluded', () => {
    const ordered = [10, 11, 12, 13, 14, 15]
    const shown = [10, 12, 13]
    const closed = [11]
    expect(candidatesNotIn(ordered, [...shown, ...closed])).toEqual([14, 15])
  })
})

describe('step', () => {
  it('moves forward', () => {
    expect(step(5, 1, 1)).toBe(2)
  })

  it('wraps from the end to the front', () => {
    expect(step(5, 4, 1)).toBe(0)
  })

  it('wraps backwards from the front to the end', () => {
    expect(step(5, 0, -1)).toBe(4)
  })

  it('goes from the first candidate back to the current tab', () => {
    expect(step(5, 1, -1)).toBe(0)
  })

  it('returns 0 when there are no elements', () => {
    expect(step(0, 0, 1)).toBe(0)
  })

  it('stays at 0 when the ring holds one element', () => {
    expect(step(1, 0, 1)).toBe(0)
    expect(step(1, 0, -1)).toBe(0)
  })
})

describe('seedFromTabStrip', () => {
  it('uses tab strip order with the active tab first', () => {
    const tabs = [
      { id: 10, active: false, index: 0 },
      { id: 11, active: true, index: 1 },
      { id: 12, active: false, index: 2 },
    ]
    expect(seedFromTabStrip(tabs)).toEqual([11, 10, 12])
  })

  it('ignores tabs without an id', () => {
    const tabs = [
      { id: undefined, active: false, index: 0 },
      { id: 11, active: true, index: 1 },
    ]
    expect(seedFromTabStrip(tabs)).toEqual([11])
  })

  it('keeps plain tab strip order when no tab is active', () => {
    const tabs = [
      { id: 12, active: false, index: 1 },
      { id: 10, active: false, index: 0 },
    ]
    expect(seedFromTabStrip(tabs)).toEqual([10, 12])
  })
})
