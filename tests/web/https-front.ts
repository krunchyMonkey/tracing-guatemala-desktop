import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A throwaway HTTPS front for the Google-mode browser spec (#181). The real
// deployment puts a TLS reverse proxy in front of the host's HTTPS listener
// (docs/operations/https-lan.md); here an HTTP CONNECT proxy plays both that
// proxy and Google:
//   - tg.example.test   -> terminated here, forwarded to 127.0.0.1:<livePort + 2>
//                          with Host, Origin and every other header untouched;
//   - fake-google.test  -> a tiny consent page with "Continue as <name>" links.
// The certificate is generated at test time into a temp folder and deleted
// afterwards: no key or certificate is ever committed. Not a spec file.

export const APP_NAME = 'tg.example.test'
export const GOOGLE_NAME = 'fake-google.test'
export const APP_ORIGIN = `https://${APP_NAME}`

export function opensslAvailable(): boolean {
  const probe = spawnSync('openssl', ['version'], { stdio: 'ignore' })
  return probe.status === 0
}

export interface HttpsFront {
  /** The proxy address for Playwright's `proxy.server`. */
  proxyUrl: string
  close(): Promise<void>
}

function makeCertificate(folder: string): { key: string; cert: string } {
  const keyFile = join(folder, 'key.pem')
  const certFile = join(folder, 'cert.pem')
  const made = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${APP_NAME}`,
      '-addext',
      `subjectAltName=DNS:${APP_NAME},DNS:${GOOGLE_NAME}`,
      '-keyout',
      keyFile,
      '-out',
      certFile
    ],
    { stdio: 'ignore' }
  )
  if (made.status !== 0) throw new Error('openssl could not create the throwaway test certificate')
  return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') }
}

const consentPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fake Google</title></head>
<body style="font-family: sans-serif; margin: 2rem">
<h1>Fake Google sign-in</h1>
<p>Test page. Choose a made-up person.</p>
<ul>
${['alex', 'bea', 'cara']
  .map((name) => `<li><a href="${APP_ORIGIN}/api/v1/auth/google/callback?code=${name}&amp;state=x">Continue as ${name}</a></li>`)
  .join('\n')}
</ul>
<p><a href="${APP_ORIGIN}/api/v1/auth/google/callback?error=access_denied&amp;state=x">Cancel</a></p>
</body></html>`

export async function startHttpsFront(livePort: number): Promise<HttpsFront> {
  const folder = mkdtempSync(join(tmpdir(), 'tg-https-front-'))
  const { key, cert } = makeCertificate(folder)

  const forward = (req: IncomingMessage, res: ServerResponse) => {
    const upstream = httpRequest(
      { host: '127.0.0.1', port: livePort + 2, method: req.method, path: req.url, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      }
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  }

  const tls = createHttpsServer({ key, cert }, (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0]
    if (host === APP_NAME) {
      forward(req, res)
    } else if (host === GOOGLE_NAME && req.url?.startsWith('/auth')) {
      const body = consentPage()
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    } else {
      res.writeHead(404).end()
    }
  })

  const sockets = new Set<Socket>()
  const proxy = createHttpServer((_req, res) => res.writeHead(405).end())
  proxy.on('connect', (req, client: Socket, head) => {
    sockets.add(client)
    client.once('close', () => sockets.delete(client))
    client.on('error', () => client.destroy())
    const [name] = (req.url ?? '').split(':')
    if (name !== APP_NAME && name !== GOOGLE_NAME) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) client.unshift(head)
    // The TLS server takes the tunnelled socket over and speaks HTTPS on it.
    tls.emit('connection', client)
  })

  await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done))
  const port = (proxy.address() as AddressInfo).port
  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      tls.closeAllConnections()
      await Promise.all([new Promise((done) => proxy.close(done)), new Promise((done) => tls.close(done))])
      rmSync(folder, { recursive: true, force: true })
    }
  }
}
