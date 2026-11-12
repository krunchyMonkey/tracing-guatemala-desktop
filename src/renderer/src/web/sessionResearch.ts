/** What a session reaches in research (#246), for display only. */
export type ResearchReach = 'own' | 'all' | 'none'

/** The session's `research` value is untrusted: anything outside the allow-list is treated as absent. */
export function parseResearchReach(value: unknown): ResearchReach | undefined {
  return value === 'own' || value === 'all' || value === 'none' ? value : undefined
}
