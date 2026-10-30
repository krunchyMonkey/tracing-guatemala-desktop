import { request, type IncomingHttpHeaders } from 'node:http'
import { expect } from 'vitest'
import type { RunningLiveServer } from '../../src/server/server'

// Shared by the Live web host tests (#110, #15): real HTTP requests to a
// RunningLiveServer, with a launch-link sign-in. Fictional data only.

export interface Reply {
  status: number
  headers: IncomingHttpHeaders
  text: string
  json: () => unknown
}

export function send(
  server: RunningLiveServer,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string | Buffer
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, method, path, agent: false, headers: { Host: `127.0.0.1:${server.port}`, ...headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) })
        })
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.end(body)
    else req.end()
  })
}

export interface Signed {
  cookie: string
  csrf: string
}

export async function signIn(server: RunningLiveServer): Promise<Signed> {
  const launch = await send(server, 'GET', new URL(server.launchUrl).pathname + new URL(server.launchUrl).search)
  expect(launch.status).toBe(303)
  const cookie = (launch.headers['set-cookie']?.[0] ?? '').split(';')[0]!
  const session = (await send(server, 'GET', '/api/v1/session', { Cookie: cookie })).json() as { csrfToken: string }
  return { cookie, csrf: session.csrfToken }
}

export function writeHeaders(server: RunningLiveServer, signed: Signed): Record<string, string> {
  return {
    Origin: server.origin,
    'Content-Type': 'application/json',
    Cookie: signed.cookie,
    'X-TG-CSRF': signed.csrf
  }
}

export const without = (headers: Record<string, string>, name: string): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name))

export async function call<T = unknown>(server: RunningLiveServer, signed: Signed, name: string, ...args: unknown[]): Promise<T> {
  const reply = await send(server, 'POST', `/api/v1/call/${name}`, writeHeaders(server, signed), JSON.stringify({ args }))
  expect(reply.status, reply.text).toBe(200)
  return (reply.json() as { result: T }).result
}
