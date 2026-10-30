// Stable, app-owned anchors for guides (#102). Screens spread `guideAnchor(...)`
// on the element a guide points at; the ids never depend on styling or layout.
// This file imports no guidance library.

export const guideAnchors = [
  'home-welcome',
  'clients-search',
  'clients-add',
  'client-summary',
  'client-history',
  'client-archive',
  'case-header'
] as const

export type GuideAnchorId = (typeof guideAnchors)[number]

export function guideAnchor(id: GuideAnchorId): { 'data-guide-id': GuideAnchorId } {
  return { 'data-guide-id': id }
}
