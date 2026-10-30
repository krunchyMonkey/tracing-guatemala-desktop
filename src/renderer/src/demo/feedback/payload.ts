// Private researcher feedback (#102): what the demo may send, and nothing else.
// Only the form's own fields, an allowlisted screen label, the optional tour step
// id and the app version leave the page. Never URLs, UUIDs, query strings, client
// names or any other value on screen. The host validates the same shape again
// (scripts/demo-feedback.mjs); tests keep the two in step.

export const feedbackCategories = ['bug', 'confusing', 'improvement', 'other'] as const
export type FeedbackCategory = (typeof feedbackCategories)[number]

export const categoryLabels: Record<FeedbackCategory, string> = {
  bug: 'Something is broken',
  confusing: 'Something is confusing',
  improvement: 'An idea to improve it',
  other: 'Something else'
}

export const screenLabels = ['Home', 'Directory', 'New Client', 'Client Profile', 'Case', 'Settings'] as const
export type ScreenLabel = (typeof screenLabels)[number]

export const feedbackLimits = { title: 120, comments: 4000, steps: 2000 } as const

export interface FeedbackDraft {
  category: FeedbackCategory
  title: string
  comments: string
  steps: string
  screen: string
  guideStep?: string | null
  appVersion: string
  idempotencyKey: string
}

export interface FeedbackPayload {
  idempotencyKey: string
  category: FeedbackCategory
  title: string
  comments: string
  steps?: string
  screen: ScreenLabel
  guideStep?: string
  appVersion: string
}

const STEP = /^[a-z0-9-]{1,40}$/
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,20})?$/
const KEY = /^[A-Za-z0-9_-]{16,64}$/

/** Names the screen from the current route path alone; the path itself is never sent. */
export function screenLabelFor(pathname: string): ScreenLabel {
  const path = pathname.split('?')[0] ?? ''
  if (path === '/clients/new') return 'New Client'
  if (path === '/clients') return 'Directory'
  if (path.startsWith('/clients/')) return 'Client Profile'
  if (path.startsWith('/cases')) return 'Case'
  if (path.startsWith('/settings')) return 'Settings'
  return 'Home'
}

/** A random request key; crypto.getRandomValues also exists on plain-HTTP origins. */
export function newIdempotencyKey(source: { getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array } = globalThis.crypto): string {
  const bytes = source.getRandomValues(new Uint8Array(12))
  return `fb-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

const collapse = (text: string) => text.trim().replace(/\s+/g, ' ')

/** Copies only allowlisted fields from `draft` (extra properties are ignored) and enforces the limits. */
export function buildFeedbackPayload(draft: FeedbackDraft): FeedbackPayload {
  const category = feedbackCategories.includes(draft.category) ? draft.category : 'other'
  const screen = (screenLabels as readonly string[]).includes(draft.screen) ? (draft.screen as ScreenLabel) : 'Home'
  const steps = draft.steps.trim().slice(0, feedbackLimits.steps)
  const payload: FeedbackPayload = {
    idempotencyKey: KEY.test(draft.idempotencyKey) ? draft.idempotencyKey : '',
    category,
    title: collapse(draft.title).slice(0, feedbackLimits.title),
    comments: draft.comments.trim().slice(0, feedbackLimits.comments),
    screen,
    appVersion: VERSION.test(draft.appVersion) ? draft.appVersion : '0.0.0'
  }
  if (steps) payload.steps = steps
  if (draft.guideStep && STEP.test(draft.guideStep)) payload.guideStep = draft.guideStep
  return payload
}

/** Plain text for the Copy feedback fallback: the same fields the payload would carry. */
export function feedbackAsText(payload: FeedbackPayload): string {
  return [
    `Category: ${categoryLabels[payload.category]}`,
    `Title: ${payload.title}`,
    `Screen: ${payload.screen}`,
    ...(payload.guideStep ? [`Tour step: ${payload.guideStep}`] : []),
    `App version: ${payload.appVersion}`,
    '',
    'Comments:',
    payload.comments,
    ...(payload.steps ? ['', 'Steps to reproduce:', payload.steps] : [])
  ].join('\n')
}
