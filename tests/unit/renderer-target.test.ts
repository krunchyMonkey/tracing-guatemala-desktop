import { describe, expect, it } from 'vitest'
import { resolveRendererTarget } from '../../src/main/renderer-target'

describe('resolveRendererTarget', () => {
  it('loads the bundled renderer from app://renderer without a dev server', () => {
    expect(resolveRendererTarget(undefined)).toEqual({
      mode: 'production',
      entryUrl: 'app://renderer/index.html',
      origin: 'app://renderer'
    })
  })

  it('uses a loopback dev server in development', () => {
    expect(resolveRendererTarget('http://localhost:5173')).toEqual({
      mode: 'development',
      entryUrl: 'http://localhost:5173/',
      origin: 'http://localhost:5173'
    })
  })

  it.each(['http://example.com:5173', 'https://localhost:5173', 'file:///C:/index.html'])(
    'rejects a non-loopback or non-http dev server (%s)',
    (url) => {
      expect(() => resolveRendererTarget(url)).toThrow()
    }
  )
})
