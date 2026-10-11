import { ConfigSchema } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import type { StatusCollector } from '../src/collector.ts'
import { COLLECTORS, makeCollector } from '../src/collectors.ts'
import { gitLoad } from '../src/git.ts'
import { testCollector } from './conformance.ts'

// Both collectors, held to the one suite: the look in this process, and the
// look in a child the window owns.

testCollector('here', () => makeCollector('here'))
testCollector('child', () => makeCollector('child'))

describe('the registry', () => {
  it('names every collector there is, and refuses a name it does not have', () => {
    expect(Object.keys(COLLECTORS).sort()).toEqual(['child', 'here'])
    expect(() => makeCollector('daemon')).toThrow(/no status collector called daemon/)
  })
})

describe('looking in a child', () => {
  const opened: StatusCollector[] = []
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((collector) => collector.close()))
  })

  it('looks in another process, and the window starts no git of its own', async () => {
    const r = mkrepo()
    for (let i = 0; i < 3; i++) r.addTask(`t${i}`, { project: 'app' })
    const look = makeCollector('child')
    opened.push(look)
    const before = gitLoad().started
    const answer = await look.collect({
      config: ConfigSchema.parse({
        workspace: { adopt: false },
        projects: { app: { root: r.root } },
      }),
      now: Date.now(),
      home: tmp('tade-child-home-'),
      tadeHome: r.home,
      pr: false,
      lanes: {},
    })
    if (!answer.known) throw new Error(answer.why)
    // The fork storm is the child's: every git process of the look was
    // started over there, and none of them here.
    expect(answer.spent.pid).not.toBe(process.pid)
    expect(answer.spent.spawns).toBeGreaterThanOrEqual(3 * 3)
    expect(gitLoad().started - before).toBe(0)
  })
})
