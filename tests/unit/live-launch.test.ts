import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ensurePrivateDir } from '../../src/server/data-dir'
import { isLaunchUrl, openCommand, openInBrowser } from '../../src/server/open-browser'

// `--open` and the data folder's permissions (#117). Nothing here opens a browser.

const launch = 'http://127.0.0.1:4180/launch?token=abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123_-abc'

describe('isLaunchUrl', () => {
  it('accepts only a plain http://127.0.0.1:<port> link', () => {
    expect(isLaunchUrl(launch)).toBe(true)
    expect(isLaunchUrl('http://127.0.0.1:1/')).toBe(true)
  })

  it.each([
    ['another host', 'http://example.com:4180/launch?token=x'],
    ['localhost', 'http://localhost:4180/launch?token=x'],
    ['a LAN address', 'http://192.168.1.20:4180/launch?token=x'],
    ['https', 'https://127.0.0.1:4180/launch?token=x'],
    ['no port', 'http://127.0.0.1/launch?token=x'],
    ['credentials that move the real host', 'http://127.0.0.1:80@evil.example/launch'],
    ['a look-alike host', 'http://127.0.0.1.evil.example:4180/'],
    ['a file link', 'file:///C:/Windows/System32/calc.exe'],
    ['a program name', 'calc.exe'],
    ['leading text', ' http://127.0.0.1:4180/'],
    ['an empty string', '']
  ])('refuses %s', (_name, url) => {
    expect(isLaunchUrl(url)).toBe(false)
  })
})

describe('openCommand', () => {
  it.each([
    ['win32', 'rundll32', ['url.dll,FileProtocolHandler', launch]],
    ['darwin', 'open', [launch]],
    ['linux', 'xdg-open', [launch]],
    ['freebsd', 'xdg-open', [launch]]
  ] as const)('on %s runs %s with the link as a single argument', (platform, command, args) => {
    expect(openCommand(launch, platform)).toEqual({ command, args })
  })

  it('builds nothing for a link that is not a launch link', () => {
    expect(openCommand('http://example.com:4180/', 'win32')).toBeNull()
    expect(openCommand('calc.exe', 'linux')).toBeNull()
  })
})

describe('openInBrowser', () => {
  function fakeSpawn() {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const spawnImpl = vi.fn(() => child)
    return { child, spawnImpl: spawnImpl as never as Parameters<typeof openInBrowser>[2], calls: spawnImpl }
  }

  it('starts the command without a shell, detached, and does not wait for it', () => {
    const { child, spawnImpl, calls } = fakeSpawn()
    const onFailure = vi.fn()
    expect(openInBrowser(launch, onFailure, spawnImpl)).toBe(true)
    const [command, args, options] = calls.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
    expect(args).toContain(launch)
    expect(command).toMatch(/^(rundll32|open|xdg-open)$/)
    expect(options).toMatchObject({ shell: false, detached: true, stdio: 'ignore' })
    expect(child.unref).toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('runs nothing for a link that is not a launch link', () => {
    const { spawnImpl, calls } = fakeSpawn()
    const onFailure = vi.fn()
    expect(openInBrowser('http://example.com:4180/', onFailure, spawnImpl)).toBe(false)
    expect(calls).not.toHaveBeenCalled()
  })

  it('reports a browser that cannot be started, whether it throws or errors later', () => {
    const onFailure = vi.fn()
    const throwing = (() => {
      throw new Error('ENOENT')
    }) as never
    expect(openInBrowser(launch, onFailure, throwing)).toBe(true)
    expect(onFailure).toHaveBeenCalledTimes(1)

    const { child, spawnImpl } = fakeSpawn()
    openInBrowser(launch, onFailure, spawnImpl)
    child.emit('error', new Error('ENOENT'))
    expect(onFailure).toHaveBeenCalledTimes(2)
  })
})

describe('ensurePrivateDir', () => {
  it.each(['linux', 'darwin'] as const)('restricts the folder to its owner (0700) on %s', (platform) => {
    const root = mkdtempSync(join(tmpdir(), 'tg-perm-test-'))
    try {
      const chmod = vi.fn()
      const dir = join(root, 'profile', 'backups')
      ensurePrivateDir(dir, { platform, chmod })
      expect(chmod).toHaveBeenCalledExactlyOnceWith(dir, 0o700)
      expect(statSync(dir).isDirectory()).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves Windows permissions to the per-user AppData folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-perm-test-'))
    try {
      const chmod = vi.fn()
      ensurePrivateDir(join(root, 'profile'), { platform: 'win32', chmod })
      expect(chmod).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('really sets mode 0700 on this system, including an existing folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-perm-test-'))
    try {
      ensurePrivateDir(root)
      expect(statSync(root).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
