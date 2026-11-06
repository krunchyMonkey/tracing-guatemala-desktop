import { expect, it } from 'vitest'

// TEMPORARY (#190): proves CI fails on lint, type and test errors. Removed in the next commit.
const unusedCanary = 1
const typed: number = 'not a number'
it('canary fails on purpose', () => {
  expect(typed).toBe(2)
})
