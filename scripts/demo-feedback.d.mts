import type { IncomingMessage, ServerResponse } from 'node:http'

// Types for demo-feedback.mjs, so the TypeScript tests can import it.

export const STATUS_PATH: string
export const SUBMIT_PATH: string
export const MAX_BODY_BYTES: number
export const DEFAULT_GITHUB_API: string
export const CATEGORIES: readonly string[]
export const SCREENS: readonly string[]
export const LIMITS: { title: number; comments: number; steps: number }
export const RATE_LIMITS: { perMinute: number; perHour: number }

export type FeedbackConfig = { ok: true; token: string; projectId: string; apiUrl: string } | { ok: false; reason: string }
export function loadFeedbackConfig(env: Record<string, string | undefined>): FeedbackConfig
export function generateAccessCode(): string
export function codesMatch(expected: string, given: string): boolean

export interface ValidFeedback {
  idempotencyKey: string
  category: string
  title: string
  comments: string
  steps?: string
  screen: string
  guideStep?: string
  appVersion: string
}
export function validateFeedbackPayload(input: unknown): { ok: true; value: ValidFeedback } | { ok: false }
export function buildDraftIssue(payload: ValidFeedback): { title: string; body: string }

export interface FeedbackBridge {
  accessCode: string
  init(): Promise<boolean>
  handle(req: IncomingMessage, res: ServerResponse): boolean
  isEnabled(): boolean
  setHeaders(headers: Record<string, string>): void
}
export function createFeedbackBridge(options: {
  env: Record<string, string | undefined>
  origin: string
  host: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  log?: (line: string) => void
  now?: () => number
  accessCode?: string
  upstreamTimeoutMs?: number
}): FeedbackBridge
