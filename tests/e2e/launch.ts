import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'

/** A throwaway user-data directory, so tests never touch the real app profile or database. */
export function createTestUserData(): string {
  return mkdtempSync(join(tmpdir(), 'tracing-guatemala-e2e-'))
}

/** Launch the built app (out/) as production loads it, against `userDataDir`. */
export function launchBuiltApp(userDataDir: string = createTestUserData()): Promise<ElectronApplication> {
  // Shells launched from VS Code can set ELECTRON_RUN_AS_NODE, which makes Electron run as plain Node.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[0] !== 'ELECTRON_RENDERER_URL'
    )
  )
  env['TRACING_GUATEMALA_TEST_USER_DATA'] = userDataDir
  return electron.launch({ args: ['.'], cwd: resolve(__dirname, '../..'), env })
}
