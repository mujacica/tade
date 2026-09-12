#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { wilcoHome } from '@wilco/core'
import { Daemon } from './server.ts'

// wilcod: the long-lived process that owns lanes and the event log.
// Started in the background by `wilco daemon start`, or run in the foreground
// for debugging.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const home = wilcoHome()

const daemon = await Daemon.start({
  home,
  version: pkg.version,
  ...(process.env.WILCO_DRIVER ? { driver: process.env.WILCO_DRIVER } : {}),
})

// `wilco daemon start` waits for this line before returning.
process.stdout.write(`wilcod listening on ${daemon.socketPath}\n`)

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    void daemon.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
}
