// Types for demo-artifact.mjs, so the TypeScript tests can import it.

export interface DemoManifest {
  schema: 'tg-demo-artifact/1'
  name: string
  version: string
  sourceSha: string
  builtAt: string
  digest: string
  files: Record<string, string>
}

export const MANIFEST: string
export const MAX_TOTAL_BYTES: number
export const ALLOWED_URL_HOSTS: Set<string>
export const FORBIDDEN_CONTENT: Array<[string, RegExp]>
export function hashArtifact(dir: string): { files: Record<string, string>; digest: string }
export function writeManifest(dir: string, info: { sha: string; version: string; builtAt: string }): DemoManifest
export function verifyArtifact(dir: string, options?: { expectDigest?: string }): string[]
