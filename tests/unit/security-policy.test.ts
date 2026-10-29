import { describe, expect, it } from 'vitest'
import { resolveRendererTarget } from '../../src/main/renderer-target'
import { describeBlockedUrl, isAllowedRequestUrl, isSameOrigin, originOf } from '../../src/main/security-policy'

const production = resolveRendererTarget(undefined)
const development = resolveRendererTarget('http://localhost:5173')

describe('originOf / isSameOrigin', () => {
  it('builds an origin for the custom app:// scheme', () => {
    expect(originOf('app://renderer/index.html#/clients')).toBe('app://renderer')
  })

  it('returns null for unparseable or host-less URLs', () => {
    expect(originOf('not a url')).toBeNull()
    expect(originOf('about:blank')).toBeNull()
  })

  it('does not treat look-alike hosts as the same origin', () => {
    expect(isSameOrigin('app://renderer.evil/index.html', 'app://renderer')).toBe(false)
    expect(isSameOrigin('http://localhost:5174/', 'http://localhost:5173')).toBe(false)
  })
})

describe('isAllowedRequestUrl', () => {
  it('allows the bundled renderer, data: images and devtools in production', () => {
    expect(isAllowedRequestUrl('app://renderer/assets/index.js', production)).toBe(true)
    expect(isAllowedRequestUrl('data:image/png;base64,AAAA', production)).toBe(true)
    expect(isAllowedRequestUrl('devtools://devtools/bundled/inspector.html', production)).toBe(true)
  })

  it.each([
    'https://example.com/',
    'http://localhost:5173/',
    'ws://localhost:5173/',
    'file:///C:/Windows/win.ini',
    'blob:app://renderer/1234',
    'app://other/index.html'
  ])('blocks %s in production', (url) => {
    expect(isAllowedRequestUrl(url, production)).toBe(false)
  })

  it('allows only the dev server and its HMR socket in development', () => {
    expect(isAllowedRequestUrl('http://localhost:5173/src/main.tsx', development)).toBe(true)
    expect(isAllowedRequestUrl('ws://localhost:5173/', development)).toBe(true)
    expect(isAllowedRequestUrl('ws://localhost:9999/', development)).toBe(false)
    expect(isAllowedRequestUrl('https://fonts.googleapis.com/css', development)).toBe(false)
  })
})

describe('describeBlockedUrl', () => {
  it('reports only the scheme, never the full URL', () => {
    expect(describeBlockedUrl('https://example.com/search?name=Fictional+Person')).toBe('https:')
  })
})
