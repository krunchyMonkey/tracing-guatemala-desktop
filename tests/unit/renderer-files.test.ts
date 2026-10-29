import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentTypeFor, resolveRendererFile } from '../../src/main/renderer-files'

const root = resolve('/fake/out/renderer')

describe('resolveRendererFile', () => {
  it('serves index.html for the root path', () => {
    expect(resolveRendererFile(root, 'app://renderer/')).toBe(join(root, 'index.html'))
  })

  it('maps asset paths inside the renderer directory', () => {
    expect(resolveRendererFile(root, 'app://renderer/assets/index-abc.js')).toBe(join(root, 'assets', 'index-abc.js'))
  })

  // The URL parser collapses literal and %2e dot segments before we see them.
  it.each(['app://renderer/../main/index.js', 'app://renderer/%2e%2e/main/index.js'])(
    'keeps normalized dot segments inside the root (%s)',
    (url) => {
      expect(resolveRendererFile(root, url)).toBe(join(root, 'main', 'index.js'))
    }
  )

  it.each([
    'app://renderer/assets/..%2F..%2F..%2Fsecret.txt',
    'app://renderer/..%5C..%5Csecret.txt',
    'app://renderer/%00index.html',
    'app://renderer/%E0%A4%A',
    'app://other/index.html',
    'https://renderer/index.html'
  ])('rejects %s', (url) => {
    expect(resolveRendererFile(root, url)).toBeNull()
  })
})

describe('contentTypeFor', () => {
  it('maps known extensions and falls back to octet-stream', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('app.JS')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('archive.zip')).toBe('application/octet-stream')
  })
})
