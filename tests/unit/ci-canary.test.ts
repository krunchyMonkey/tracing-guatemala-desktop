import { expect, it } from 'vitest'

// TEMPORARY (#190): proves CI fails on type and test errors. Removed before merge.
const typed: number = 'not a number'
it('canary fails on purpose', () => {
  expect(typed).toBe(2)
})
