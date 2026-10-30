// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DemoBanner } from '../../src/renderer/src/components/DemoBanner'
import { DemoToolsProvider } from '../../src/renderer/src/components/DemoTools'
import { DemoToolbar } from '../../src/renderer/src/demo/DemoToolbar'
import { PRIVACY_TEXT } from '../../src/renderer/src/demo/FeedbackDialog'
import { createDemoApi } from '../../src/renderer/src/demo/demoApi'
import { buildDemoData } from '../../src/renderer/src/demo/sampleData'
import { screenLabelFor } from '../../src/renderer/src/demo/feedback/payload'
import { AppRuntimeProvider, type AppRuntime } from '../../src/renderer/src/runtime/AppRuntime'

// The demo's Send feedback form (#102): Copy-only by default, Submit only when the
// host says so. The fetch calls here go to a stub; nothing leaves the test.

const runtime: AppRuntime = {
  mode: 'demo',
  switcher: { kind: 'unavailable', reason: 'not-available' },
  data: createDemoApi(buildDemoData(), { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }),
  backup: null,
  cases: null
}

function open(path = '/clients') {
  render(
    <AppRuntimeProvider runtime={runtime}>
      <MemoryRouter initialEntries={[path]}>
        <DemoToolsProvider tools={<DemoToolbar />}>
          <DemoBanner />
        </DemoToolsProvider>
      </MemoryRouter>
    </AppRuntimeProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
}

function fill() {
  fireEvent.change(screen.getByLabelText('Short title'), { target: { value: 'Confusing button' } })
  fireEvent.change(screen.getByLabelText('Comments'), { target: { value: 'I did not know what it did.' } })
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Send feedback', () => {
  let fetchStub: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
  })

  afterEach(() => {
    cleanup()
    document.head.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('shows the privacy text and Copy feedback, with no Submit and no request, in the default demo', async () => {
    open()
    expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBeTruthy()
    expect(screen.getByText(PRIVACY_TEXT)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Submit/ })).toBeNull()
    expect(screen.queryByLabelText('Access code')).toBeNull()
    expect(screen.getByText(/Sending isn’t turned on/)).toBeTruthy()
    fill()
    fireEvent.click(screen.getByRole('button', { name: 'Copy feedback' }))
    const box = (await screen.findByLabelText('Feedback to copy')) as HTMLTextAreaElement
    expect(box.value).toContain('Title: Confusing button')
    expect(box.value).toContain('Screen: Directory')
    expect(box.value).toContain('App version:')
    expect(box.value).not.toMatch(/clients|http|[0-9a-f]{8}-[0-9a-f]{4}/)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('offers the four categories and enforces the length limits', () => {
    open()
    const options = [...screen.getByLabelText('What kind of feedback?').querySelectorAll('option')].map((o) => o.getAttribute('value'))
    expect(options).toEqual(['bug', 'confusing', 'improvement', 'other'])
    expect(screen.getByLabelText('Short title').getAttribute('maxlength')).toBe('120')
    expect(screen.getByLabelText('Comments').getAttribute('maxlength')).toBe('4000')
    expect(screen.getByLabelText('Steps to reproduce (optional)').getAttribute('maxlength')).toBe('2000')
  })

  it('closes on Escape', () => {
    open()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('falls back to Copy when the host reports sending is off', async () => {
    document.head.innerHTML = '<meta name="tg-feedback" content="available">'
    fetchStub.mockResolvedValue(json({ enabled: false }))
    open()
    await waitFor(() => expect(screen.getByText(/Sending isn’t turned on/)).toBeTruthy())
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(fetchStub.mock.calls[0]![0]).toBe('/__feedback/status')
    expect(screen.queryByRole('button', { name: /^Submit/ })).toBeNull()
  })

  it('falls back to Copy when the status call fails or is not JSON', async () => {
    document.head.innerHTML = '<meta name="tg-feedback" content="available">'
    fetchStub.mockResolvedValue(new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    open()
    await waitFor(() => expect(screen.getByText(/Sending isn’t turned on/)).toBeTruthy())
  })

  it('submits only the allowlisted payload with the access code header, and confirms', async () => {
    document.head.innerHTML = '<meta name="tg-feedback" content="available">'
    fetchStub.mockImplementation((url: string) =>
      Promise.resolve(url === '/__feedback/status' ? json({ enabled: true }) : json({ ok: true, itemUrl: 'https://github.com/orgs/fake/projects/1' }))
    )
    open('/clients/de300000-0000-4000-8000-000000000001')
    await screen.findByLabelText('Access code')
    fill()
    fireEvent.change(screen.getByLabelText('Access code'), { target: { value: 'ABCD-2345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit feedback' }))
    await screen.findByText('Feedback added to private project.')
    expect(screen.getByRole('link', { name: 'Open the private project' }).getAttribute('href')).toBe('https://github.com/orgs/fake/projects/1')

    const [url, init] = fetchStub.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('/__feedback')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Feedback-Code']).toBe('ABCD-2345')
    const sent = JSON.parse(init.body as string) as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual(['appVersion', 'category', 'comments', 'idempotencyKey', 'screen', 'title'])
    expect(sent['screen']).toBe('Client Profile')
    expect(JSON.stringify(sent)).not.toMatch(/de300000|clients|http|lucia/i)
  })

  it('keeps the text on failure and reuses the same idempotency key to retry', async () => {
    document.head.innerHTML = '<meta name="tg-feedback" content="available">'
    const posts: string[] = []
    fetchStub.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/__feedback/status') return Promise.resolve(json({ enabled: true }))
      posts.push((JSON.parse(init!.body as string) as { idempotencyKey: string }).idempotencyKey)
      return Promise.resolve(posts.length === 1 ? json({ ok: false }, 502) : json({ ok: true }))
    })
    open()
    await screen.findByLabelText('Access code')
    fill()
    fireEvent.change(screen.getByLabelText('Access code'), { target: { value: 'ABCD-2345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit feedback' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be sent/)
    expect((screen.getByLabelText('Comments') as HTMLTextAreaElement).value).toBe('I did not know what it did.')
    fireEvent.click(screen.getByRole('button', { name: 'Submit feedback' }))
    await screen.findByText('Feedback added to private project.')
    expect(posts).toHaveLength(2)
    expect(posts[0]).toBe(posts[1])
  })

  it('explains a wrong access code', async () => {
    document.head.innerHTML = '<meta name="tg-feedback" content="available">'
    fetchStub.mockImplementation((url: string) => Promise.resolve(url === '/__feedback/status' ? json({ enabled: true }) : json({ ok: false }, 401)))
    open()
    await screen.findByLabelText('Access code')
    fill()
    fireEvent.change(screen.getByLabelText('Access code'), { target: { value: 'WRONG' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit feedback' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/access code was not accepted/)
  })
})

describe('screenLabelFor', () => {
  it.each([
    ['/', 'Home'],
    ['/clients', 'Directory'],
    ['/clients/new', 'New Client'],
    ['/clients/de300000-0000-4000-8000-000000000001', 'Client Profile'],
    ['/clients/de300000-0000-4000-8000-000000000001/edit', 'Client Profile'],
    ['/cases/de300000-0000-4000-8000-200000000001', 'Case'],
    ['/cases', 'Case'],
    ['/settings', 'Settings'],
    ['/anything-else', 'Home']
  ])('labels %s as %s without sending the path', (path, label) => {
    expect(screenLabelFor(path)).toBe(label)
  })
})
