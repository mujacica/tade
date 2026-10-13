import { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { buildProgram, COMMANDS, commandsFor } from '../src/program.ts'

// The program loads the command typed and nothing else, so each command's
// module is only paid for by that command. What that rests on is a table of
// names (`COMMANDS`), and a table is right on the day it was written: these
// hold it to what each module actually registers.

const io = { out: () => {}, err: () => {} }

describe('the commands, loaded one at a time', () => {
  it('names every command each module adds, and only those', async () => {
    const everyName = new Set<string>()
    for (const command of COMMANDS) {
      const program = new Command('tade')
      ;(await command.load())(program, io, () => {})
      const added = program.commands.map((one) => one.name())
      expect(added.toSorted(), command.names.join(',')).toEqual([...command.names].toSorted())
      for (const name of added) {
        expect(everyName.has(name), `${name} is listed twice`).toBe(false)
        everyName.add(name)
      }
    }
  }, 60_000)

  it('loads the one typed, the window when none is, and all of them otherwise', () => {
    const names = (args: string[]) => commandsFor(args).flatMap((one) => one.names)
    expect(names(['status', '--json'])).toEqual(['status'])
    expect(names(['logs', 'app/refunds'])).toContain('logs')
    expect(names(['logs', 'app/refunds'])).not.toContain('status')
    expect(names([])).toEqual(['app'])
    expect(names(['--safe'])).toEqual(['app'])
    // Help lists everything, and a name that is not a command is commander's
    // to answer, which it can only do knowing every one there is.
    expect(commandsFor(['--help'])).toBe(COMMANDS)
    expect(commandsFor(['status', '-h'])).toBe(COMMANDS)
    expect(commandsFor(['help'])).toBe(COMMANDS)
    expect(commandsFor(['nothing-called-this'])).toBe(COMMANDS)
  })

  it('builds a program with the command typed in it, and not the rest', async () => {
    const program = await buildProgram(io, () => {}, ['status'])
    expect(program.commands.map((one) => one.name())).toEqual(['status'])
  })
})
