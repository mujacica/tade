import type { AppState } from './model.ts'

// The commands you can type, and what a typed line is.
//
// Its own file because it is its own subject: `model.ts` is what the window
// should *show*, and this is the small grammar of what you can ask it for —
// the list, whether each can be done now, how a line splits into a verb and
// what it is for, and whether a line is a command at all. It came out when
// `model.ts` reached the size a file is allowed to be, and the cut is where
// the subjects already differed rather than wherever the line fell.
//
// Pure, like `model.ts`: a state in, a list out.

export interface Action {
  name: string
  about: string
  /** False when it cannot be done right now, with `about` saying why. */
  ready: boolean
}

/**
 * The slash commands, and whether each one can be done at the moment.
 *
 * Listed rather than hidden when they cannot: a menu that changes shape as
 * you work is one you have to re-read every time, and "no agent is running
 * here" is more use than an option that silently is not there.
 */
export function actions(state: AppState): Action[] {
  const focused = state.panes.find((pane) => pane.task === state.focused)
  const running = state.panes.filter((pane) => pane.lane !== null)
  return [
    {
      name: '/new',
      about: focused
        ? `a new agent beside ${focused.name}: /new what it should do`
        : 'a new agent: /new what it should do',
      ready: true,
    },
    {
      name: '/stop',
      about: running.length > 0 ? 'stop an agent, keeping its work' : 'nothing is running',
      ready: running.length > 0,
    },
    {
      name: '/open',
      about: state.panes.length > 0 ? 'go to an agent: /open name' : 'no agents yet',
      ready: state.panes.length > 0,
    },
    { name: '/project', about: 'add a git repository Tade can work in', ready: true },
    { name: '/settings', about: 'see and change what Tade has been told', ready: true },
    { name: '/away', about: 'pair a phone, and see which devices are let in', ready: true },
    { name: '/help', about: 'what the keys do', ready: true },
    { name: '/quit', about: 'close the window; agents carry on if they can', ready: true },
  ]
}

/**
 * A typed command line: the word, and whatever was said after it.
 *
 * Most commands take the rest of the line as what they are for — `/new fix
 * the double charge` is a whole piece of work, said in one go — so the two are split
 * once, here, rather than by each caller guessing.
 */
export function parseCommand(typed: string): { name: string; rest: string } {
  const line = typed.trim()
  const space = line.search(/\s/)
  if (space < 0) return { name: line, rest: '' }
  return { name: line.slice(0, space), rest: line.slice(space + 1).trim() }
}

/** The actions matching what has been typed after the slash. */
export function matchActions(state: AppState, typed: string): Action[] {
  // Only the first word chooses the command: the words after it are what the
  // command is *for*, and they must not narrow the list to nothing while you
  // are still typing them.
  const want = parseCommand(typed).name.replace(/^\//, '').toLowerCase()
  const all = actions(state)
  if (want === '') return all
  return all.filter((action) => action.name.slice(1).startsWith(want))
}

/** Whether what is typed is a command rather than something to say. */
export function isAction(typed: string | null): boolean {
  return typed?.startsWith('/') === true
}
