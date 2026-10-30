import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultLiveDataDir, ensurePrivateDir, sameDir } from './data-dir'
import { LanHostError } from './lan'

// The real-data gate for the home-network listener (#136). Over plain HTTP,
// pairing codes, sessions and every record can be read by anyone on the network,
// so until the HTTPS phase (#139) the listener only runs on a profile that was
// deliberately created for fictional test data.

export const LAN_TEST_MARKER = 'lan-test-profile.json'

const WHY =
  'Home-network access over plain HTTP is for fictional test data only: HTTP is unencrypted, so anyone on the network could read what is sent. Real client records need the HTTPS phase.'

function real(path: string): string {
  const full = resolve(path)
  try {
    return realpathSync(full)
  } catch {
    return full
  }
}

function isDefaultProfile(dataDir: string): boolean {
  const defaultDir = defaultLiveDataDir()
  return sameDir(resolve(dataDir), defaultDir, process.platform) || sameDir(real(dataDir), real(defaultDir), process.platform)
}

/** Throws LanHostError unless `dataDir` is a marked fictional-test profile that is not the default one. */
export function assertLanDataAllowed(dataDir: string): void {
  if (isDefaultProfile(dataDir)) {
    throw new LanHostError(`--lan-host can't be used with your default data folder. ${WHY} Use --init-lan-test-profile with an explicit --data-dir for a test profile.`)
  }
  const file = join(dataDir, LAN_TEST_MARKER)
  let ok: boolean
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    ok = typeof parsed === 'object' && parsed !== null && (parsed as { kind?: unknown }).kind === 'fictional-test'
  } catch {
    ok = false
  }
  if (!ok) {
    throw new LanHostError(`This data folder isn't marked as a fictional test profile. ${WHY} Make a new test profile with --init-lan-test-profile and an explicit --data-dir.`)
  }
}

/** Writes the marker, only into a folder that doesn't exist yet or is empty and isn't the default profile. */
export function initLanTestProfile(dataDir: string): void {
  if (isDefaultProfile(dataDir)) throw new LanHostError(`That is your default data folder. ${WHY}`)
  if (existsSync(dataDir)) {
    if (!statSync(dataDir).isDirectory() || readdirSync(dataDir).length > 0) {
      throw new LanHostError(`--init-lan-test-profile only works on a folder that doesn't exist yet or is empty, so real data is never marked as test data. ${WHY}`)
    }
  } else {
    ensurePrivateDir(dataDir)
  }
  writeFileSync(
    join(dataDir, LAN_TEST_MARKER),
    JSON.stringify({ kind: 'fictional-test', note: 'Fictional test data only. Plain HTTP on the home network is unencrypted.', createdAt: new Date().toISOString() }, null, 2),
    { flag: 'wx' }
  )
}
