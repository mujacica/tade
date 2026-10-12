import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { taskFilePath } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { TaskSnapshot } from '../../src/model.ts'
import { Routes } from '../../src/wire/routes.ts'

// What each agent's harness lets a person ask of it, learned as the tasks
// refresh.
//
// A harness is the task file's word, else its project's route in the config, so
// what it offers can only move when one of those does. It was learned again
// for every task on every two-second beat all the same: two YAML files read and
// parsed per agent, to learn what was already known. Counted in beats, never
// over a sleep.

/** What a harness declares it can be asked, as far as the menus read it. */
const capabilities = {
  model: 'live' as const,
  thinking: 'live' as const,
  rename: 'live' as const,
  thinkingLevels: ['low' as const, 'high' as const],
  why: {},
}

function learning() {
  const home = tmp('tade-routes-')
  const task = 'app/refunds'
  const file = taskFilePath(home, task)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'id: app/refunds\nproject: app\n')
  let asked = 0
  let drawn = 0
  const wire = {
    opts: {
      home,
      config: ConfigSchema.parse({ projects: {} }),
      client: {
        agentHarness: async () => {
          asked++
          return { harness: 'pi', account: null, capabilities }
        },
      },
    },
    live: { worktreeOf: () => '/wt/refunds' },
    draw: () => {
      drawn++
    },
  }
  const routes = new Routes(wire as never, {} as never)
  const tasks = [{ task, state: 'working' }] as TaskSnapshot[]
  return {
    routes,
    wire,
    file,
    asked: () => asked,
    drawn: () => drawn,
    beat: () => routes.learnHarnesses(tasks),
  }
}

describe('what an agent’s harness offers, learned as the tasks refresh', () => {
  it('is read once, and not again on a beat where nothing it is read from moved', async () => {
    const { routes, asked, drawn, beat } = learning()
    await beat()
    expect(asked()).toBe(1)
    expect(drawn()).toBe(1)
    expect(routes.offersFor('app/refunds')?.harness).toBe('pi')
    for (let beats = 0; beats < 10; beats++) await beat()
    expect(asked(), 'the task file was read again for nothing').toBe(1)
    expect(drawn()).toBe(1)
  })

  it('is read again when its task file is written, or the config is', async () => {
    const { wire, file, asked, beat } = learning()
    await beat()
    // What choosing another harness for it writes.
    writeFileSync(file, 'id: app/refunds\nproject: app\nharness: codex\n')
    await beat()
    expect(asked()).toBe(2)
    await beat()
    expect(asked()).toBe(2)
    // Every config written is a new one, routes and all.
    wire.opts.config = ConfigSchema.parse({ projects: {} })
    await beat()
    expect(asked()).toBe(3)
  })
})
