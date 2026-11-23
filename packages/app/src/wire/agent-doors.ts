import { type Asker, HARNESS_CHOICES } from '@tade/core'
import { type AgentMenuIn, NotOffered } from '@tade/web'
import { awayMenuOf, type MenuExtras } from '../away-menu.ts'
import { shownName } from '../model.ts'
import {
  accountMenuItems,
  agentOffers,
  harnessMenuItems,
  menuItems,
  queueMenuItems,
  thinkingMenuItems,
} from '../panels/menu/state.ts'
import type { AccountShown } from '../panels/settings/accounts.ts'
import { notify, type Wiring } from './context.ts'

// The window's own doors for the rest of an agent's menu, for a request from
// away: the same calls a press on the window's row makes (`Agents.fromTaskMenu`,
// `Routes.choose*`, `Moves.handOver`), each throwing rather than putting a
// failure on a notice line nobody away can read, and each said in the window
// where somebody at the machine looks, naming who asked.
//
// **Workbench calls, not the face's pickers.** On a box with no screen
// (`tade serve`) there is no `Routes` and no picker to open, and the phone is
// the only screen there is — so what the window's pickers ask of the harness,
// these ask of the workbench directly, as the pickers themselves do underneath.

/** What the away view's agent verbs need of the window, one method per item. */
export interface AgentMenuDoors {
  /** Stop it, take it off the list, remove its worktree and branch. Throws why not. */
  remove(task: string, by: Asker): Promise<void>
  /** Call it something else. Answers the name it settled on. */
  rename(task: string, title: string, by: Asker): Promise<string>
  /** Switch its running session's model. Answers the id it switched to. */
  model(task: string, model: string, by: Asker): Promise<string>
  /** How hard its running session thinks. Answers the level. */
  thinking(task: string, level: string, by: Asker): Promise<string>
  /** Run it as another account (`''` its own sign-in): what came of it, in words. */
  account(task: string, account: string, by: Asker): Promise<string>
  /** Run it in another harness: what came of it, in words. */
  harness(task: string, harness: string, by: Asker): Promise<string>
  /** Hand it to another machine: what was set going, in words. */
  move(task: string, machine: string, by: Asker): Promise<string>
  /** Its menu, as the window's row would draw it, for a device. Null where there is no such task. */
  menu(task: string, theirs: boolean): Promise<AgentMenuIn | null>
}

/** What the doors need beyond the wiring: the subjects that hold a removal and a hand-over. */
export interface AgentMenuParts {
  /** The `Agents` subject's own removal, which marks the agent stopped on purpose first. */
  removeExactly(task: string, by: Asker): Promise<void>
  /** What handing over offers and does, where this window links machines; null where it does not. */
  handsOver(): {
    handItems(task: string): ReturnType<typeof menuItems>
    handOver(task: string, machine: string, by: Asker): Promise<string>
  } | null
}

/** The doors over one window. */
export function agentMenuDoors(wire: Wiring, parts: AgentMenuParts): AgentMenuDoors {
  const client = wire.opts.client
  const where = (task: string): string => {
    const worktree = wire.live?.worktreeOf(task)
    if (!worktree) throw new Error(`the window does not know where ${task} works`)
    return worktree
  }
  /** Said where somebody at the machine looks, with who asked, so nothing from away is silent. */
  const said = (words: string): void => {
    notify(wire, words)
    wire.draw()
  }
  return {
    remove: async (task, by) => {
      await parts.removeExactly(task, by)
    },
    rename: async (task, title, by) => {
      const named = await client.renameAgent({ task, worktree: where(task), title, by })
      await wire.live?.refresh()
      said(`${by} renamed ${task}: ${named}`)
      return named
    },
    model: async (task, model, by) => {
      // Among what its own harness offers now, asked again at the act: a name
      // the right shape and in no list is nothing here by that name.
      const offered = await client.agentModels(task)
      const known = offered.models.some((one) => one.id === model || one.id.endsWith(`/${model}`))
      if (!known) throw new NotOffered(`${offered.harness} offers no model called ${model}`)
      const chosen = await client.setAgentModel(task, model)
      said(`${by} switched ${task} to ${chosen.id}`)
      return chosen.id
    },
    thinking: async (task, level, by) => {
      const chosen = await client.setAgentThinking(task, level)
      said(`${by} set ${task} to think at ${chosen.level}`)
      return chosen.level
    },
    account: async (task, account, by) => {
      // An account by its name, among the ones this machine set up for the
      // harness it runs in — never a credential, and never one made here.
      const known = await client.agentHarness(task)
      if (account !== '' && wire.opts.config.accounts[account]?.harness !== known.harness) {
        throw new NotOffered(`there is no ${known.harness} account called ${account}`)
      }
      const done = await client.setAgentAccount({
        task,
        worktree: where(task),
        account: account === '' ? null : account,
      })
      const as = done.account ?? done.ownName ?? 'its own sign-in'
      const words = `runs as ${as}${done.carried ? ', its conversation with it' : ''}${
        done.restarted ? ', started again there' : ' from its next start'
      }`
      await wire.live?.refresh()
      said(`${by}: ${task} ${words}`)
      return words
    },
    harness: async (task, harness, by) => {
      const choice = HARNESS_CHOICES.find((one) => one.id === harness)
      if (choice?.ready !== true) throw new NotOffered(`there is no harness here called ${harness}`)
      const done = await client.setAgentHarness({ task, worktree: where(task), harness })
      const words = `runs in ${done.harness}${done.restarted ? ', started again there' : ' from its next start'}`
      await wire.live?.refresh()
      said(`${by}: ${task} ${words}`)
      return words
    },
    move: async (task, machine, by) => {
      const hands = parts.handsOver()
      if (hands === null) {
        throw new Error(
          'handing work to another machine is the window’s: open Tade on this machine',
        )
      }
      // Only a machine its own menu offers it to now: one that holds its
      // project and is linked, never a name the device made up.
      const offered = hands.handItems(task).find((one) => one.id === `hand:${machine}`)
      if (offered === undefined) throw new NotOffered(`${machine} does not hold ${task}'s project`)
      if (offered.off !== undefined) throw new NotOffered(`${machine}: ${offered.off}`)
      const words = await hands.handOver(task, machine, by)
      said(`${by}: ${words}`)
      return words
    },
    menu: (task, theirs) => menuFor(wire, parts, task, theirs),
  }
}

/**
 * One agent's menu, as the window's own row draws it (`menuItems`), with the
 * lists under its items asked the way the window's pickers ask them — and the
 * two only a person's own device may use (accounts, machines) read only for
 * one, so nobody else's menu costs a look at them.
 */
async function menuFor(
  wire: Wiring,
  parts: AgentMenuParts,
  task: string,
  theirs: boolean,
): Promise<AgentMenuIn | null> {
  const client = wire.opts.client
  const facts = wire.live?.factsOf(task) ?? null
  const pane = wire.state.panes.find((one) => one.task === task)
  if (facts === null && pane === undefined) return null
  const lane = client.lane(`${task}/agent` as never)
  const running = lane?.alive === true
  // A harness that could not be asked is said where somebody at the machine
  // looks, and the menu then offers what the window's does when it does not
  // know yet: everything, refused at the act if the harness says no.
  const known = await client.agentHarness(task).catch((err: unknown) => {
    wire.note(err)
    return null
  })
  const offers = known ? agentOffers(known.harness, known.capabilities) : null
  if (pane?.queued) {
    const items = queueMenuItems(pane.queued)
    return { items: awayMenuOf(items, extrasOf(pane ? shownName(pane) : task, offers, running)) }
  }
  const finished = wire.live?.queueFacts().finished.get(task) ?? null
  const items = menuItems(
    {
      lane: running ? (lane?.id ?? `${task}/agent`) : null,
      state: pane?.state ?? 'unknown',
      finished: pane?.finished ?? (finished === null ? null : { by: '' }),
    },
    wire.live?.changes(task).length ?? 0,
    offers,
    theirs ? (parts.handsOver()?.handItems(task) ?? []) : [],
  )
  const vitals = wire.live?.vitals(task) ?? null
  const harness = offers?.harness ?? known?.harness ?? ''
  const models = running
    ? await client
        .agentModels(task)
        .then((offered) => ({
          list: offered.models.map((one) => ({
            id: one.id,
            label: one.id.split('/').slice(1).join('/') || one.id,
          })),
          current: vitals?.model ?? null,
          why: offered.why === null ? null : `${offered.harness} ${offered.why}`,
        }))
        .catch((err: unknown) => {
          // Said at the machine whole, and on the phone as what it means there.
          wire.note(err)
          return {
            list: [],
            current: vitals?.model ?? null,
            why: 'its harness could not be asked which models it runs: it is said at the machine',
          }
        })
    : null
  const accounts = theirs
    ? await client
        .accounts()
        .then((views) =>
          accountMenuItems(
            views.map(
              (view) => ({ ...view, limits: null, agents: 0, forNewAgents: false }) as AccountShown,
            ),
            harness,
            known?.account ?? '',
          ),
        )
        .catch((err: unknown) => {
          wire.note(err)
          return null
        })
    : []
  const title = pane ? shownName(pane) : task.slice(task.indexOf('/') + 1)
  return {
    items: awayMenuOf(items, {
      ...extrasOf(title, offers, running),
      models,
      thinking: vitals?.thinking ?? null,
      levels: thinkingMenuItems(vitals?.thinking ?? null, offers?.levels),
      accounts,
      harnesses: harnessMenuItems(HARNESS_CHOICES, harness),
    }),
  }
}

/** What every menu knows of an agent, before its lists are asked. */
function extrasOf(title: string, offers: MenuExtras['offers'], running: boolean): MenuExtras {
  return {
    running,
    title,
    offers,
    models: null,
    thinking: null,
    levels: [],
    accounts: [],
    harnesses: [],
  }
}
