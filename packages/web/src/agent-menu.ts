import type { Reach } from './reach.ts'
import { inTime } from './request.ts'
import type { ServerOptions } from './serving.ts'
import { verbFor } from './verbs.ts'

// One agent's menu, as the window's own row offers it, for a device to draw
// (`GET /api/agent/:project/:task/menu`).
//
// **The window's list, not a second one.** What a right-click on an agent's
// row offers is `menuItems` in `@tade/app` — open, start, stop, mark finished,
// changes, rename, model, account, the machines it can be handed to, park,
// remove — each with what its harness offers and, where it cannot be done
// now, the window's own word for why (`off`). The window builds that list and
// says, beside each item, which verb carries it out from away (`act`); this
// file only takes away what *this device* may not ask for. So a phone's menu
// and the window's are one function of one agent, and an item the window
// turns off is off on the phone with the same reason.
//
// **What a device may not ask is not drawn, not drawn off**: with acting
// turned off every act is left out. The items that are the page's own (open
// its screen, copy its branch) stay, because they ask nothing of the machine.
// **Possible, never permitted**: the gate asks the setting, the device and the
// state again at the act.
//
// Asked when somebody opens the menu, never on a beat: a model list is a
// question to the agent's harness (Codex runs a program to answer), so it is
// bounded (`MENU_MS`) and a harness that did not answer in time is said on
// the item rather than waited on.

/** How long the window may take to build one agent's menu before the page is told it could not. */
export const MENU_MS = 6_000

/** One choice under an item: a model, a level, an account, a harness, a machine. */
export interface MenuChoiceIn {
  /** What the act sends: the model id, the level, the account's name (`''` its own sign-in). */
  id: string
  label: string
  /** The one it is on now. */
  current: boolean
  /** Why it cannot be chosen now, in the window's own word. */
  off: string | null
  note: string | null
}

/**
 * What pressing an item does from away.
 *
 * - `verb` — one act, the verb's own body and nothing typed but `with`
 *   (the machine a hand-over goes to, the queue's choice);
 * - `type` — one act whose body carries what is typed (`rename`), starting
 *   from `value`;
 * - `choose` — a list, and the act carries the chosen `id`;
 * - `page` — the page's own: open the agent's screen or its changes, copy
 *   its branch;
 * - `here` — only at the machine (an editor on its screen), so drawn off with
 *   the window's reason and never sent.
 */
export type MenuAct =
  | { kind: 'verb'; verb: string; with?: Readonly<Record<string, string>> }
  | { kind: 'type'; verb: string; value: string }
  | { kind: 'choose'; verb: string; choices: MenuChoiceIn[]; why: string | null }
  | { kind: 'page'; does: 'open' | 'copy-branch' | 'changes' }
  | { kind: 'here' }

/** One item, as the window's menu has it, and what it does from away. */
export interface MenuItemIn {
  id: string
  label: string
  off: string | null
  note: string | null
  danger: boolean
  divider: boolean
  act: MenuAct
}

/** One agent's menu as the window builds it, for one device. */
export interface AgentMenuIn {
  items: MenuItemIn[]
}

/**
 * The window's half: one agent's menu, built when it is asked. Null where the
 * task is not one the window has.
 */
export interface WebMenus {
  menu(task: string): Promise<AgentMenuIn | null>
}

/** What the page is answered. */
export interface AgentMenuOut {
  task: string
  /** Whether this device reads the task at all; `false` is answered with no items. */
  here: boolean
  items: MenuItemIn[]
  /** Why there are no items, in words, where the window could not build them. */
  why: string | null
}

/** What a device may ask, as the menu needs it: whether acting is on. */
export interface MenuStanding {
  acting: boolean
}

/**
 * Leave out what no device may ask for here: an act that is not a verb, and
 * every act at all where acting is off. The page's own items stay. Dividers move with what is
 * left, so a menu never opens on a rule.
 */
export function menuFor(items: readonly MenuItemIn[], standing: MenuStanding): MenuItemIn[] {
  const kept = items.filter((item) => {
    const act = item.act
    if (act.kind === 'page' || act.kind === 'here') return true
    const verb = verbFor(act.verb)
    return verb !== null && standing.acting
  })
  return kept.map((item, at) => (at === 0 && item.divider ? { ...item, divider: false } : item))
}

/**
 * The route's answer: the window's menu for a task this device reads, cut to
 * what it may ask. A task it does not read is the same answer as one that is
 * not there — `here: false` and nothing — so a crafted name learns nothing.
 */
export async function menuHere(
  params: Readonly<Record<string, string>>,
  reach: Reach,
  standing: MenuStanding,
  opts: Pick<ServerOptions, 'readingFor' | 'menus'>,
): Promise<AgentMenuOut> {
  const task = `${params.project ?? ''}/${params.task ?? ''}`
  const here = opts.readingFor(reach).agent(task).here === true
  if (!here) return { task, here: false, items: [], why: null }
  if (opts.menus === undefined) {
    return { task, here, items: [], why: 'this machine does not offer an agent’s menu from away' }
  }
  // A window that threw is the server's to say: its one catch answers `broke`
  // with a request id and writes the detail as a warning at the machine.
  const built = await inTime<AgentMenuIn | null | 'late'>(opts.menus.menu(task), MENU_MS, 'late')
  if (built === 'late') {
    return { task, here, items: [], why: 'the machine took too long to say what it offers' }
  }
  if (built === null) return { task, here, items: [], why: 'the machine does not have this agent' }
  return { task, here, items: menuFor(built.items, standing), why: null }
}
