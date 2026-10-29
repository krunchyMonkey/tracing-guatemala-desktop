import { parseArgs } from 'node:util'
import { chooseLanHost, DEFAULT_PORT, startDemoServer } from './demo-server.mjs'

// `npm run demo:lan [-- --host <address>] [-- --port <n>]`: serves the built
// browser demo over HTTP on the trusted home LAN. See docs/demo/lan-preview.md.

const { values } = parseArgs({
  options: { host: { type: 'string' }, port: { type: 'string' } }
})
const requested = values.host ?? process.env['DEMO_HOST']
const port = Number(values.port ?? process.env['DEMO_PORT'] ?? DEFAULT_PORT)

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('The port must be a whole number from 1024 to 65535.')
  process.exit(1)
}

const choice = chooseLanHost(requested)
if (!choice.ok) {
  console.error(choice.error)
  process.exit(1)
}

if (choice.note) console.log(choice.note)

let server
try {
  server = await startDemoServer({ host: choice.host, port })
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

console.log(`
Tracing Guatemala browser demo (fictional data only)

  Open on a phone, tablet or computer on the same home network:
    ${server.url}#/clients

  Plain HTTP for a trusted home network only. Never forward this port on your
  router or expose it to the internet. Press Ctrl+C to stop.
`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void server.close().finally(() => {
      console.log('Demo server stopped.')
      process.exit(0)
    })
  })
}
