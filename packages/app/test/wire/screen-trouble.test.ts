import { rmSync } from 'node:fs'
import { Workbench } from '@tade/workbench'
import { expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { screenTrouble } from '../../src/wire/screens.ts'
import { HARNESSES } from './harness.ts'

// What a borrowed screen could not say once it had gone — a driver that could
// not stop what it ran — is a `warning` in the journal, which telemetry carries,
// and never a line on stderr under the window's drawing.

it('writes what a screen could not say as a warning in the journal', async () => {
  const home = tmp('tade-app-')
  const client = await Workbench.open({ home, harnesses: HARNESSES })
  try {
    const noted: unknown[] = []
    const wire = { opts: { client }, note: (err: unknown) => noted.push(err) } as unknown as Wiring
    await screenTrouble(wire, 'A program a screen ran may still be running')
    const warnings = await client.events({ types: ['warning'] })
    expect(warnings.map((one) => one.detail)).toEqual([
      { message: 'A program a screen ran may still be running' },
    ])
    expect(noted).toEqual([])
  } finally {
    await client.close().catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
})
