import { describe, expect, it } from 'vitest'
import { parseResearchReach } from '../../src/renderer/src/web/sessionResearch'

// #246-a: the session's `research` value is untrusted; only the allow-list is believed.

describe('parseResearchReach', () => {
  it('passes own, all and none through', () => {
    for (const value of ['own', 'all', 'none'] as const) expect(parseResearchReach(value)).toBe(value)
  })

  it('treats anything else as undefined', () => {
    for (const value of ['everything', 'ALL', '', 42, null, undefined, true, {}, ['own']]) expect(parseResearchReach(value)).toBeUndefined()
  })
})
