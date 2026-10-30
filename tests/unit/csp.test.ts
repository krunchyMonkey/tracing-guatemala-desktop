import { describe, expect, it } from 'vitest'
import { buildContentSecurityPolicy } from '../../src/shared/csp'

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/)
      return [name!, values.join(' ')]
    })
  )
}

describe('buildContentSecurityPolicy', () => {
  it('locks production down to bundled assets with no network connections', () => {
    const csp = directives(buildContentSecurityPolicy({ mode: 'production' }))
    expect(csp.get('default-src')).toBe("'none'")
    expect(csp.get('script-src')).toBe("'self'")
    expect(csp.get('style-src')).toBe("'self'")
    expect(csp.get('connect-src')).toBe("'none'")
    expect(csp.get('object-src')).toBe("'none'")
    expect(csp.get('frame-ancestors')).toBe("'none'")
  })

  it('never allows eval, in any mode', () => {
    const prod = buildContentSecurityPolicy({ mode: 'production' })
    const dev = buildContentSecurityPolicy({ mode: 'development', devServerOrigin: 'http://localhost:5173' })
    expect(prod).not.toContain('unsafe-eval')
    expect(dev).not.toContain('unsafe-eval')
  })

  it('lets only the Live web app fetch its own origin, and nothing else changes', () => {
    const live = directives(buildContentSecurityPolicy({ mode: 'production', connectToSelf: true }))
    const desktop = directives(buildContentSecurityPolicy({ mode: 'production' }))
    expect(live.get('connect-src')).toBe("'self'")
    expect(new Map([...live].filter(([name]) => name !== 'connect-src'))).toEqual(
      new Map([...desktop].filter(([name]) => name !== 'connect-src'))
    )
  })

  it('omits frame-ancestors for <meta> delivery', () => {
    const csp = directives(buildContentSecurityPolicy({ mode: 'production', forMetaTag: true }))
    expect(csp.has('frame-ancestors')).toBe(false)
  })

  it('allows only the dev server and its HMR socket in development', () => {
    const csp = directives(
      buildContentSecurityPolicy({ mode: 'development', devServerOrigin: 'http://localhost:5173' })
    )
    expect(csp.get('connect-src')).toBe("'self' ws://localhost:5173")
  })

  it('requires a dev server origin in development', () => {
    expect(() => buildContentSecurityPolicy({ mode: 'development' })).toThrow()
  })
})
