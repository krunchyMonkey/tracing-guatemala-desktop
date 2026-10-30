import type { NetworkInterfaceInfo } from 'node:os'

// Types for demo-server.mjs, so the TypeScript tests can import it.

export interface LocalAddress {
  address: string
  name: string
}

export type HostChoice = { ok: true; host: string; note?: string } | { ok: false; error: string }

export const DEFAULT_PORT: number
export const demoDir: string
export function isPrivateIPv4(address: string): boolean
export function isLoopbackIPv4(address: string): boolean
export function localIPv4Addresses(interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>): LocalAddress[]
export function chooseLanHost(requested: string | undefined, addresses?: LocalAddress[]): HostChoice
export interface FeedbackOptions {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
  log?: (line: string) => void
  fetchImpl?: typeof fetch
}
export function allowConnectToSelf(policy: string): string
export function startDemoServer(options: {
  host: string
  port?: number
  feedback?: FeedbackOptions | null
}): Promise<{ url: string; close: () => Promise<void>; feedback: { accessCode: string; enabled: boolean } | null }>
