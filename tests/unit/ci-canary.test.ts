import { expect, it } from 'vitest'

// TEMPORARY (#190): proves CI fails on a failing test. Removed before merge.
it('canary fails on purpose', () => {
  expect(1).toBe(2)
})
