// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LaunchRequired } from '../../src/renderer/src/web/LaunchRequired'
import { createLiveApi, fetchSession, LiveApiError } from '../../src/renderer/src/web/liveApi'
import { defaultQuery } from '../../src/shared/client-model'

// The Live web app's data adapter (#110), with fetch stubbed. Fictional data only.

afterEach(cleanup)

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function setup(responses: Response[] = [reply(200, { result: [] })]) {
  const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift() ?? reply(200, { result: null }))
  const onSessionLost = vi.fn()
  const pickFile = vi.fn<() => Promise<File | null>>(async () => null)
  const download = vi.fn()
  const api = createLiveApi({ csrfToken: 'token-123', onSessionLost, fetchImpl, pickFile, download })
  return { api, fetchImpl, onSessionLost, pickFile, download }
}

describe('Live API adapter', () => {
  it('posts each call as JSON to the versioned API with the CSRF token', async () => {
    const { api, fetchImpl } = setup()
    await expect(api.data.listClients(defaultQuery)).resolves.toEqual([])
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('/api/v1/call/listClients')
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-TG-CSRF': 'token-123' }
    })
    expect(JSON.parse(init!.body as string)).toEqual({ args: [defaultQuery] })
  })

  it('reports a lost session and rejects with only the error code', async () => {
    const { api, onSessionLost } = setup([reply(401, { error: 'not-signed-in' })])
    await expect(api.data.getAppInfo()).rejects.toEqual(new LiveApiError('not-signed-in'))
    expect(onSessionLost).toHaveBeenCalledOnce()
  })

  it('downloads a backup after the host makes it', async () => {
    const fileName = 'Tracing Guatemala backup 2026-10-29 08-05-09.tgbackup'
    const { api, download } = setup([reply(200, { result: { ok: true, fileName, clients: 2, notes: 1 } })])
    await expect(api.backup.createBackup()).resolves.toMatchObject({ ok: true, fileName })
    expect(download).toHaveBeenCalledWith(`/api/v1/backup/download/${encodeURIComponent(fileName)}`)
  })

  it('treats a dismissed file picker as cancelled without uploading', async () => {
    const { api, fetchImpl } = setup()
    await expect(api.backup.chooseBackupToRestore()).resolves.toEqual({ ok: false, reason: 'cancelled' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uploads a chosen backup as bytes with its name and date', async () => {
    const { api, fetchImpl, pickFile } = setup([reply(200, { result: { ok: false, reason: 'not-a-backup' } })])
    const file = new File(['bytes'], 'My backup.tgbackup', { lastModified: 1_700_000_000_000 })
    pickFile.mockResolvedValueOnce(file)
    await expect(api.backup.chooseBackupToRestore()).resolves.toEqual({ ok: false, reason: 'not-a-backup' })
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('/api/v1/backup/upload')
    expect(init?.body).toBe(file)
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/octet-stream',
      'X-TG-File-Name': 'My%20backup.tgbackup',
      'X-TG-Last-Modified': '1700000000000',
      'X-TG-CSRF': 'token-123'
    })
  })

  it('reads the session state', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => reply(200, { authenticated: false }))
    await expect(fetchSession(fetchImpl)).resolves.toEqual({ authenticated: false })
  })
})

describe('LaunchRequired', () => {
  it('explains how to open the app without showing any data', () => {
    render(<LaunchRequired reason="signed-out" />)
    expect(screen.getByRole('heading', { name: 'Open Tracing Guatemala from its link' })).toBeTruthy()
    expect(screen.getByText(/private link shown in the Tracing Guatemala window/)).toBeTruthy()
  })

  it('says nothing was lost after a restart', () => {
    render(<LaunchRequired reason="session-ended" />)
    expect(screen.getByText(/Nothing was lost/)).toBeTruthy()
  })
})
