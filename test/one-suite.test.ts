import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SLOT_ENV, slotHolders, takeMachineSlot } from '@tade/checks-core'
import { describe, expect, it } from 'vitest'
import { tmp } from './fixtures/mkrepo.ts'
import { NARROW, takeTurn } from './one-suite.ts'

// The suite's own guard: a full suite typed into a shell waits for the same
// turn on this machine as one Tade started, and a narrow one does not.

const turn = (home: string, over: Partial<Parameters<typeof takeTurn>[0]> = {}) => {
  const said: string[] = []
  const taking = takeTurn({
    files: NARROW + 1,
    watch: false,
    root: '/work/mine',
    env: { TADE_HOME: home },
    say: (line) => said.push(line),
    everyMs: 10,
    ...over,
  })
  return { taking, said }
}

describe('a full suite takes its turn on the machine', () => {
  it('holds a slot while it runs and gives it back at teardown', async () => {
    const home = tmp('tade-suite-')
    const release = await turn(home).taking
    expect((await slotHolders(home)).map((one) => one.where)).toEqual(['/work/mine'])
    await release()
    expect(await slotHolders(home)).toEqual([])
  })

  it('waits behind a suite somewhere else, saying whose, and starts when it ends', async () => {
    const home = tmp('tade-suite-')
    const other = await takeMachineSlot(home, 1, { what: 'tests', where: '/work/other' })
    setTimeout(() => {
      if (!('held' in other)) void other.release()
    }, 80)
    const { taking, said } = turn(home)
    const release = await taking
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('tests in /work/other')
    expect(said[0]).toContain('vitest run <file>')
    await release()
  })

  it('fails rather than starting beside it when its wait runs out', async () => {
    const home = tmp('tade-suite-')
    await takeMachineSlot(home, 1, { what: 'tests', where: '/work/other' })
    await expect(turn(home, { waitMs: 30 }).taking).rejects.toThrow(/tests in \/work\/other/)
  })

  it('reads how many suites the machine runs from Tade’s own config', async () => {
    const home = tmp('tade-suite-')
    writeFileSync(join(home, 'config.yaml'), 'checks:\n  suites: 2\n')
    await takeMachineSlot(home, 2, { what: 'tests', where: '/work/other' })
    const release = await turn(home, { waitMs: 0 }).taking
    expect(await slotHolders(home)).toHaveLength(2)
    await release()
  })
})

describe('what goes straight through', () => {
  it('a narrow run, a watch, and a suite inside a run that already holds its slot', async () => {
    const home = tmp('tade-suite-')
    const held = await takeMachineSlot(home, 1, { what: 'tests', where: '/work/tade' })
    if ('held' in held) throw new Error('the slot should have been free')
    for (const over of [
      { files: NARROW },
      { watch: true },
      { env: { TADE_HOME: home, [SLOT_ENV]: held.path } },
    ]) {
      const { taking, said } = turn(home, { ...over, waitMs: 0 })
      await (await taking)()
      expect(said).toEqual([])
    }
    // And nothing of theirs was taken: the one slot is still the run's.
    expect((await slotHolders(home)).map((one) => one.where)).toEqual(['/work/tade'])
  })

  it('a home that cannot be written, which is said rather than failing the suite', async () => {
    const file = join(tmp('tade-suite-'), 'not-a-folder')
    writeFileSync(file, '')
    const { taking, said } = turn(file)
    await (await taking)()
    expect(said.join('')).toContain('runs without waiting')
  })

  it('a slot named in the environment that nobody holds any more is no pass', async () => {
    const home = tmp('tade-suite-')
    const gone = await takeMachineSlot(home, 1, { what: 'tests', where: '/work/tade' })
    if ('held' in gone) throw new Error('the slot should have been free')
    await gone.release()
    const release = await turn(home, { env: { TADE_HOME: home, [SLOT_ENV]: gone.path } }).taking
    expect((await slotHolders(home)).map((one) => one.where)).toEqual(['/work/mine'])
    await release()
  })
})
