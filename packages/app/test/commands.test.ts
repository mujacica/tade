import { describe, expect, it } from 'vitest'
import { actions, isAction, matchActions, parseCommand } from '../src/commands.ts'
import { initialState } from '../src/model.ts'

// What you can ask the window for, and what a typed line is.
//
// Moved here with its subject when `commands.ts` came out of `model.ts`: the
// list, whether each can be done now, and how a line splits are one thing to
// read about, and they were being read past in a thousand lines about what the
// window shows.

describe('a typed line', () => {
  it('is a command when it starts with a slash, and otherwise is something you said', () => {
    expect(isAction('/new fix it')).toBe(true)
    expect(isAction('fix it')).toBe(false)
    expect(isAction(null)).toBe(false)
  })

  it('is the first word, and everything after it is what the command is for', () => {
    expect(parseCommand('/new fix the double charge')).toEqual({
      name: '/new',
      rest: 'fix the double charge',
    })
    expect(parseCommand('  /quit  ')).toEqual({ name: '/quit', rest: '' })
  })

  it('is narrowed by the first word alone, so typing what it is for narrows nothing', () => {
    // The words after the verb are what the command is *for*: they must not
    // take the list to nothing while somebody is still typing them.
    expect(matchActions(initialState(), '/new fix the ref').map((one) => one.name)).toEqual([
      '/new',
    ])
  })
})

describe('what the window offers', () => {
  it('offers the away view, and finds it from what is typed', () => {
    // `/away` is the only way the pairing panel is opened — there is no
    // button for it, because its whole subject is off by default — so a
    // command that fell out of this list is a panel nobody can reach.
    const listed = actions(initialState()).map((one) => one.name)
    expect(listed).toContain('/away')
    expect(matchActions(initialState(), '/aw').map((one) => one.name)).toEqual(['/away'])
    // Ready whatever the setting says: the panel's own first line is what
    // tells you it is off, and a command that hid itself would leave somebody
    // with `tade web pair` pointing at a page they cannot open.
    expect(actions(initialState()).find((one) => one.name === '/away')?.ready).toBe(true)
  })

  it('lists what cannot be done now rather than hiding it, with why', () => {
    // A menu that changes shape as you work is one you have to re-read every
    // time, and "nothing is running" is more use than an option that silently
    // is not there.
    const stop = actions(initialState()).find((one) => one.name === '/stop')
    expect(stop?.ready).toBe(false)
    expect(stop?.about).toContain('nothing is running')
  })

  it('names every one of them with a slash, which is what finds them', () => {
    for (const one of actions(initialState())) expect(one.name.startsWith('/'), one.name).toBe(true)
  })
})
