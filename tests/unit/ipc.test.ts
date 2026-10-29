import { describe, expect, it, vi } from 'vitest'
import { contracts, createValidatedHandler, IpcRejectedError, registerIpcHandlers } from '../../src/main/ipc'
import { IpcChannel } from '../../src/shared/ipc'

const trustedOrigin = 'app://renderer'
const isTrustedSender = (url: string) => url.startsWith(`${trustedOrigin}/`)
const trustedEvent = { senderFrame: { url: 'app://renderer/index.html' } } as never
const appInfo = { name: 'Tracing Guatemala', version: '0.1.0', platform: 'win32' }

describe('createValidatedHandler', () => {
  it('returns validated results for a trusted sender with valid arguments', async () => {
    const handler = createValidatedHandler(contracts.getAppInfo, isTrustedSender, () => appInfo)
    await expect(handler(trustedEvent)).resolves.toEqual(appInfo)
  })

  it.each([
    ['a foreign origin', { senderFrame: { url: 'https://example.com/' } }],
    ['a missing frame', { senderFrame: null }]
  ])('rejects calls from %s without running the handler', async (_label, event) => {
    const impl = vi.fn(() => appInfo)
    const handler = createValidatedHandler(contracts.getAppInfo, isTrustedSender, impl)
    await expect(handler(event as never)).rejects.toThrow(IpcRejectedError)
    expect(impl).not.toHaveBeenCalled()
  })

  it('rejects unexpected arguments without echoing them', async () => {
    const impl = vi.fn(() => appInfo)
    const handler = createValidatedHandler(contracts.getAppInfo, isTrustedSender, impl)
    const error = await handler(trustedEvent, 'Fictional Client Name').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(IpcRejectedError)
    expect((error as Error).message).not.toContain('Fictional Client Name')
    expect(impl).not.toHaveBeenCalled()
  })

  it('refuses to return results that break the contract', async () => {
    const handler = createValidatedHandler(contracts.getAppInfo, isTrustedSender, () => ({
      ...appInfo,
      extra: 'not part of the contract'
    }))
    await expect(handler(trustedEvent)).rejects.toThrow()
  })
})

describe('registerIpcHandlers', () => {
  it('registers exactly the channels in the shared contract', () => {
    const handle = vi.fn()
    registerIpcHandlers({ handle }, { isTrustedSender, getAppInfo: () => appInfo })
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(Object.values(IpcChannel))
  })
})
