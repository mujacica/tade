import type { MenuChoiceIn, MenuItemIn } from '@tade/web'
import type { AgentOffers, MenuItem } from './panels/menu/state.ts'

// One agent's menu for a device: the window's own `menuItems`, each item told
// what a press on it does from away.
//
// Pure, and the one place an item of the window's menu is matched to a verb:
// the list is the window's (what is offered, in what order, which are off and
// the word for why), and this only says how each is carried out from away.
// An item it does not know is carried out **at the machine only** (`here`) and
// drawn off with a sentence saying so, so a new item in the window's menu
// arrives on a phone as a reason rather than as a press nothing answers.

/** What the window knows about one agent beyond its menu, for the lists under it. */
export interface MenuExtras {
  /** Whether its agent is running: a model and how hard it thinks are a running session's. */
  running: boolean
  /** What it is called now, to start the rename from. */
  title: string
  offers: AgentOffers | null
  /** Its harness's models, asked of it; null where it was not asked (not running). */
  models: {
    list: readonly { id: string; label: string }[]
    current: string | null
    why: string | null
  } | null
  /** How hard it thinks now, as it last said. */
  thinking: string | null
  /** The thinking levels its harness offers, as the window's menu has them (`thinkingMenuItems`). */
  levels: readonly MenuItem[]
  /** The accounts it could run as (`accountMenuItems`); null where they were not read. */
  accounts: readonly MenuItem[] | null
  /** The harnesses it could run in (`harnessMenuItems`). */
  harnesses: readonly MenuItem[]
}

/** Why an item that is the machine's own is never sent: its words, by the window's id. */
const AT_THE_MACHINE: Readonly<Record<string, string>> = {
  editor: 'it opens an editor on the machine’s own screen',
  changes: 'a diff is read at the machine: no route sends one to a device',
  'queue-after': 'what it waits on is changed at the machine',
  'queue-retell': 'what it is told is changed at the machine',
}

/** The queue's own choices, by the window's item id (`queueMenuItems`). */
const QUEUE: Readonly<Record<string, string>> = {
  'queue-start': 'start',
  'queue-first': 'first',
  'queue-pause': 'pause',
  'queue-resume': 'resume',
  'queue-wait': 'wait',
  'queue-drop': 'drop',
}

/**
 * The window's menu, each item with what a press does from away, and the two
 * controls the window draws in an agent's header rather than its menu —
 * how hard it thinks, and its harness — put after the model, where a phone
 * with no header looks for them.
 */
export function awayMenuOf(items: readonly MenuItem[], extras: MenuExtras): MenuItemIn[] {
  const out: MenuItemIn[] = []
  for (const item of items) {
    out.push(itemOf(item, extras))
    if (item.id === 'model') out.push(...headerItems(extras))
  }
  return out
}

/** How hard it thinks and which harness it is in: the header's two controls, as menu items. */
function headerItems(extras: MenuExtras): MenuItemIn[] {
  const thinking = extras.offers?.thinking ?? { shown: true, support: 'live', note: null }
  const harness = extras.offers?.harness ?? 'this harness'
  const thinkingOff = !thinking.shown ? `not in ${harness}` : !extras.running ? 'not running' : null
  return [
    {
      id: 'thinking',
      label: 'Thinking…',
      off: thinkingOff,
      note: extras.thinking,
      danger: false,
      divider: false,
      act: { kind: 'choose', verb: 'thinking', choices: extras.levels.map(choiceOf), why: null },
    },
    {
      id: 'harness',
      label: 'Run in harness…',
      off: null,
      note: extras.offers?.harness ?? null,
      danger: false,
      divider: false,
      act: { kind: 'choose', verb: 'harness', choices: extras.harnesses.map(choiceOf), why: null },
    },
  ]
}

function itemOf(item: MenuItem, extras: MenuExtras): MenuItemIn {
  const base = {
    id: item.id,
    label: item.label,
    off: item.off ?? null,
    note: item.note ?? null,
    danger: item.danger === true,
    divider: item.divider === true,
  }
  const queue = QUEUE[item.id]
  if (queue !== undefined)
    return { ...base, act: { kind: 'verb', verb: 'queue', with: { change: queue } } }
  if (item.id.startsWith('hand:')) {
    return { ...base, act: { kind: 'verb', verb: 'move', with: { machine: item.id.slice(5) } } }
  }
  switch (item.id) {
    case 'open':
      // On a phone, opening it is its page: its screen, timeline and controls.
      return { ...base, note: null, act: { kind: 'page', does: 'open' } }
    case 'copy-branch':
      return { ...base, act: { kind: 'page', does: 'copy-branch' } }
    case 'start':
    case 'stop':
    case 'park':
    case 'remove':
      return { ...base, act: { kind: 'verb', verb: item.id } }
    case 'queue-remove':
      return { ...base, act: { kind: 'verb', verb: 'remove' } }
    case 'mark-done':
      return { ...base, act: { kind: 'verb', verb: 'done' } }
    case 'rename':
      return { ...base, act: { kind: 'type', verb: 'rename', value: extras.title } }
    case 'model': {
      const models = extras.models
      return {
        ...base,
        act: {
          kind: 'choose',
          verb: 'model',
          choices: (models?.list ?? []).map((one) => ({
            id: one.id,
            label: one.label,
            current: isCurrent(one.id, models?.current ?? null),
            off: null,
            note: null,
          })),
          why: models?.why ?? null,
        },
      }
    }
    case 'account':
      return {
        ...base,
        act: {
          kind: 'choose',
          verb: 'account',
          choices: (extras.accounts ?? []).map(choiceOf),
          why: extras.accounts === null ? 'the accounts could not be read now' : null,
        },
      }
    default:
      return {
        ...base,
        // Already off with the window's word, or off with why it stays here.
        off: base.off ?? AT_THE_MACHINE[item.id] ?? 'only at the machine',
        act: { kind: 'here' },
      }
  }
}

/**
 * One of the window's picker rows as a choice: its `● ` marks the one it is
 * on, which is a field here rather than two characters of a label.
 */
function choiceOf(item: MenuItem): MenuChoiceIn {
  const current = item.label.startsWith('● ')
  return {
    id: item.id,
    label: item.label.replace(/^(● | {2})/, ''),
    current,
    off: item.off ?? null,
    note: current ? null : item.note === '' ? null : (item.note ?? null),
  }
}

/**
 * Whether a model in its harness's list is the one it is on: a harness may say
 * `claude-opus-5` of `anthropic/claude-opus-5`, so either may carry the
 * provider (`Routes.inUse`'s rule).
 */
function isCurrent(id: string, current: string | null): boolean {
  if (current === null || current === '') return false
  return id === current || id.endsWith(`/${current}`) || current.endsWith(`/${id}`)
}
