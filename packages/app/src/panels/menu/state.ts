import { THINKING_LEVELS } from '@tade/core'
import { type Offer, offer, type WorkerCapabilities } from '@tade/harnesses-core'
import { close, type PanelOutcome, stay } from '../outcome.ts'
import type { AccountShown } from '../settings/state.ts'

// What can be done with the thing you right-clicked, as a list to pick from.
//
// Every menu in the window is one of these: a list of items somebody built for
// the subject it is about, and one panel that draws them all. The drawing is
// beside this in `view.ts`.

/** What a menu is for: an agent, a file or folder in FILES, a changed file, or the branch. */
export type MenuSubject =
  | { kind: 'task'; task: string }
  /** Relative to the folder FILES is showing. */
  | { kind: 'file'; path: string; folder: boolean }
  /** A changed file; `task` is null for the project's own checkout. */
  | { kind: 'change'; task: string | null; path: string }
  | { kind: 'branch' }
  /** A terminal's tab. */
  | { kind: 'terminal'; id: string }
  /** Pictures dropped or pasted on the window, waiting to be given to someone. */
  | { kind: 'images'; paths: string[] }
  /** Which harness an agent runs in. */
  | { kind: 'harness'; task: string; current: string }
  /** Which account an agent runs as: `current` empty for its harness's own sign-in. */
  | { kind: 'account'; task: string; current: string }
  /** A shell beside an agent, in its pane. */
  | { kind: 'lane'; task: string; lane: string; name: string }
  /** A note, named by when it was said and what it said. */
  | { kind: 'note'; at: string; text: string }
  /** How hard an agent thinks: `current` as it last said, or what new agents are given. */
  | { kind: 'thinking'; task: string; current: string | null }
  /** A schedule in the SMART QUEUE. */
  | { kind: 'schedule'; id: string }
  /** A project's tab along the top. `project` is its name, which is its id. */
  | { kind: 'project'; project: string }

/** A menu, opened from a ≡ or a right-click, where it was clicked. */
export interface MenuPanel {
  kind: 'menu'
  subject: MenuSubject
  /** Said along its top: the agent's or the file's name. */
  title: string
  /** Which item the keyboard is on. */
  index: number
  /**
   * Lines scrolled past, for a menu longer than the window. A menu is nearly
   * always shorter than the room there is — but nearly always is not always,
   * and the one that is not used to have its last items nowhere at all.
   */
  scroll: number
  /** Whether it follows the item the keyboard is on, until you scroll it. */
  following: boolean
  /** The screen cell it was opened from, so it appears there. */
  anchor: { row: number; col: number } | null
  busy: false
}

/** What a menu offers. Unavailable items stay listed, with the reason. */
export interface MenuItem {
  id: string
  label: string
  /** Why not, when it cannot be done now. */
  off?: string
  /** Said quietly on the right: a key, a count. */
  note?: string
  danger?: boolean
  /** A rule above it. */
  divider?: boolean
}

/** What can be done with a terminal, from its tab. */
export function terminalMenuItems(split = false): MenuItem[] {
  return [
    { id: 'run', label: 'Run a command…' },
    { id: 'find', label: 'Find…' },
    { id: 'rename', label: 'Rename…' },
    { id: 'clear', label: 'Clear' },
    split
      ? { id: 'unsplit', label: 'Unsplit', divider: true }
      : { id: 'split-beside', label: 'Split: a new terminal beside', divider: true },
    ...(split ? [] : [{ id: 'split-below', label: 'Split: a new terminal below' }]),
    { id: 'close', label: 'Close', danger: true, divider: true },
  ]
}

/**
 * What can be done with a project, from its tab: what it is called here, where
 * its tab sits, everything it is set up with, and closing it.
 *
 * Four acts and one omission worth saying out loud. **Nothing here removes
 * anything.** Close takes the project out of the config and touches nothing on
 * disk — the folder, every commit, branch and worktree, everything under
 * `.tade/` and every line of the journal stay exactly as they are — so it is
 * offered plainly, and the item says so rather than asking a question nobody
 * can answer from a menu. Deleting any of that is a person's, with git, in a
 * terminal, and there is no item for it because there is no tool for it.
 *
 * Rename is a label (`ProjectConfigSchema.title`): it says so in the item,
 * because somebody reading a menu is deciding, and "will this break my task
 * ids" is the question a rename raises the moment it is offered.
 */
export function projectMenuItems(opts: {
  /** How many agents are running in it: closing is refused while any is. */
  running: number
  first: boolean
  last: boolean
}): MenuItem[] {
  const ends = opts.first && opts.last ? 'it is the only project' : undefined
  return [
    { id: 'rename', label: 'Rename…', note: 'what it is called here' },
    {
      id: 'move-left',
      label: 'Move left',
      divider: true,
      ...(opts.first ? { off: ends ?? 'it is first' } : {}),
    },
    { id: 'move-right', label: 'Move right', ...(opts.last ? { off: ends ?? 'it is last' } : {}) },
    { id: 'configure', label: 'Configure…', divider: true, note: 'settings for this project' },
    {
      id: 'close',
      label: 'Close',
      note: 'nothing is deleted',
      danger: true,
      divider: true,
      ...(opts.running > 0
        ? {
            off: `${opts.running === 1 ? 'an agent is' : `${opts.running} agents are`} still running in it`,
          }
        : {}),
    },
  ]
}

/**
 * How hard an agent can be told to think, least to most, the one it is at
 * marked. A model that cannot think that hard takes the most it can, and says
 * which.
 */
export function thinkingMenuItems(
  current: string | null,
  levels: readonly string[] = THINKING_LEVELS,
): MenuItem[] {
  return levels.map((level) => ({
    id: level,
    label: `${level === current ? '● ' : '  '}${level}`,
    note: level === current ? 'now' : '',
  }))
}

/** What can be done with a note: read and change it whole, have its words, or take it back. */
export function noteMenuItems(): MenuItem[] {
  return [
    { id: 'edit', label: 'Edit…' },
    { id: 'copy', label: 'Copy' },
    { id: 'forget', label: 'Forget', danger: true, divider: true },
  ]
}

/** What can be done with a shell beside an agent. */
export function laneMenuItems(split: boolean, agentRunning = true): MenuItem[] {
  const off = agentRunning ? {} : { off: 'its agent is not running' }
  return [
    { id: 'rename', label: 'Rename…' },
    split
      ? { id: 'unsplit', label: 'Unsplit', divider: true }
      : { id: 'split-beside', label: 'Show beside the agent', divider: true, ...off },
    ...(split ? [] : [{ id: 'split-below', label: 'Show below the agent', ...off }]),
    { id: 'close', label: 'Close', danger: true, divider: true },
  ]
}

/**
 * Who can be given a picture: the orchestrator, each agent in the project —
 * the one in front of you first — and the terminal in front, which only gets
 * the path typed. A drop does not say where it landed, so this is asked.
 */
export function imageMenuItems(where: {
  agents: readonly { task: string; name: string; running: boolean; focused: boolean }[]
  terminal: { id: string; name: string } | null
}): MenuItem[] {
  const agents = [...where.agents].sort((a, b) => Number(b.focused) - Number(a.focused))
  return [
    { id: 'orchestrator', label: 'The orchestrator', note: 'sent with what you say next' },
    ...agents.map((agent, i) => ({
      id: `agent:${agent.task}`,
      label: agent.name,
      note: agent.focused ? 'in front of you' : '',
      ...(agent.running ? {} : { off: 'its agent is not running' }),
      ...(i === 0 ? { divider: true } : {}),
    })),
    ...(where.terminal
      ? [
          {
            id: `terminal:${where.terminal.id}`,
            label: where.terminal.name,
            note: 'types the path',
            divider: true,
          },
        ]
      : []),
  ]
}

/** The harnesses an agent could run in: the one it is on marked, the ones not yet runnable said so. */
export function harnessMenuItems(
  choices: readonly { id: string; title: string; about: string; ready: boolean }[],
  current: string,
): MenuItem[] {
  return choices.map((choice) => ({
    id: choice.id,
    label: `${choice.id === current ? '● ' : '  '}${choice.title}`,
    note: choice.id === current ? 'now' : choice.ready ? '' : 'soon',
    ...(choice.ready ? {} : { off: choice.about }),
  }))
}

export function menuPanel(
  subject: MenuSubject,
  title: string,
  anchor: MenuPanel['anchor'] = null,
): MenuPanel {
  return { kind: 'menu', subject, title, index: 0, scroll: 0, following: true, anchor, busy: false }
}

/** What can be done with a file or folder in FILES. */
export function fileMenuItems(file: {
  folder: boolean
  open: boolean
  /** git says it has uncommitted changes. */
  changed: boolean
  /** An agent is in front of you, so there is someone to ask and a change to show. */
  agent: boolean
  platform: string
}): MenuItem[] {
  const reveal = file.platform === 'darwin' ? 'Reveal in Finder' : 'Show in its folder'
  if (file.folder) {
    return [
      { id: 'toggle', label: file.open ? 'Collapse' : 'Expand', note: 'click' },
      { id: 'search', label: 'Search in this folder' },
      { id: 'editor', label: 'Open in editor' },
      { id: 'copy-path', label: 'Copy path', divider: true },
      { id: 'copy-relative', label: 'Copy relative path' },
      { id: 'reveal', label: reveal },
    ]
  }
  return [
    { id: 'open', label: 'Open', note: 'click' },
    { id: 'editor', label: 'Open in editor' },
    {
      id: 'changes',
      label: 'Show changes',
      ...(file.changed ? {} : { off: 'unchanged' }),
    },
    {
      id: 'ask',
      label: 'Ask the agent about it',
      ...(file.agent ? {} : { off: 'no agent' }),
    },
    { id: 'copy-path', label: 'Copy path', divider: true },
    { id: 'copy-relative', label: 'Copy relative path' },
    { id: 'reveal', label: reveal },
  ]
}

/** What can be done with a changed file. Discarding asks first, and only touches what is not committed. */
export function changeMenuItems(change: { uncommitted: boolean; agent: boolean }): MenuItem[] {
  return [
    { id: 'diff', label: 'Show changes', note: 'click' },
    { id: 'open', label: 'Open file' },
    { id: 'editor', label: 'Open in editor' },
    { id: 'ask', label: 'Ask the agent about it', ...(change.agent ? {} : { off: 'no agent' }) },
    { id: 'copy-path', label: 'Copy path', divider: true },
    {
      id: 'discard',
      label: 'Discard changes…',
      danger: true,
      divider: true,
      ...(change.uncommitted ? {} : { off: 'committed' }),
    },
  ]
}

/**
 * What can be done with the branch under GIT. The project's own checkout can
 * be switched; an agent's branch is where its work is, so it is renamed rather
 * than switched out from under it.
 */
export function branchMenuItems(branch: { agent: boolean; name: string }): MenuItem[] {
  if (branch.agent) {
    return [
      { id: 'rename', label: branch.name ? 'Rename branch…' : 'Name the branch now…' },
      { id: 'copy', label: 'Copy branch name', ...(branch.name ? {} : { off: 'none yet' }) },
      { id: 'changes', label: 'Show changes' },
      { id: 'copy-path', label: 'Copy worktree path', divider: true },
    ]
  }
  return [
    { id: 'switch', label: 'Switch branch…' },
    { id: 'new', label: 'New branch…' },
    { id: 'pull', label: 'Pull', note: 'fast-forward' },
    { id: 'copy', label: 'Copy branch name', divider: true },
    { id: 'copy-path', label: 'Copy path' },
  ]
}

/**
 * What a person may ask of an agent, as its harness offers it: the one rule
 * every control that changes a running agent is drawn by.
 */
export interface AgentOffers {
  harness: string
  /** Whether it can be moved to another account of its harness. */
  accounts: boolean
  model: Offer
  thinking: Offer
  rename: Offer
  /** The thinking levels it can be told, least to most. */
  levels: readonly string[]
}

/**
 * What a person may ask of the orchestrator's turn, as its harness offers it.
 *
 * Its own type rather than an agent's: the orchestrator has no lane, no
 * branch and no account of its own to change, and the one thing anybody asks
 * of it mid-turn is to stop. Read through `offer()` like everything else, so
 * no surface ever asks which harness it is.
 */
export interface ThinkerOffers {
  harness: string
  /** Stopping the turn it is on, leaving the conversation. */
  interrupt: Offer
  /**
   * The levels its harness can be told to think at, least to most. Its own,
   * like an agent's: pi thinks at `off` and Claude Code does not, and a level
   * offered that the harness has to take away again is a choice that was
   * never real.
   */
  levels: readonly string[]
}

export function thinkerOffers(harness: string, capabilities: WorkerCapabilities): ThinkerOffers {
  const abort = offer(capabilities, 'abort', capabilities.abort)
  const levels = capabilities.thinkingLevels
  // Only `live` is an interruption. `idle` waits for the turn to end and
  // `restart` starts the agent again — either would be a key that looks like
  // it stopped something and did not, so they are declined here with the
  // harness's own sentence rather than offered as a stop.
  if (abort.support === 'live') return { harness, interrupt: abort, levels }
  // The harness's own sentence where it wrote one — every `why` is written to
  // follow the harness's name — and a plain one where it did not.
  const why = capabilities.why.abort ?? 'cannot stop a turn once it has started'
  return { harness, interrupt: { ...abort, shown: false, note: why }, levels }
}

export function agentOffers(harness: string, capabilities: WorkerCapabilities): AgentOffers {
  return {
    harness,
    accounts: capabilities.accounts,
    model: offer(capabilities, 'model', capabilities.model),
    thinking: offer(capabilities, 'thinking', capabilities.thinking),
    rename: offer(capabilities, 'rename', capabilities.rename),
    levels: capabilities.thinkingLevels,
  }
}

/**
 * A task's menu, from what is true of it now. Nothing is hidden for being
 * unavailable — a menu that changes shape is one you re-read every time — so
 * what its harness cannot do is there, off, saying why.
 */
export function menuItems(
  task: { lane: string | null; state: string; finished?: { by: string } | null },
  changed: number,
  offers?: AgentOffers | null,
): MenuItem[] {
  const running = task.lane !== null
  const model = offers?.model ?? { shown: true, support: 'live', note: null }
  // A word, where a menu has room for one: the whole reason is what anything
  // that asks for it anyway is told.
  const how = { live: null, idle: 'between turns', restart: 'restarts it', none: null }[
    model.support
  ]
  return [
    { id: 'open', label: 'Open', note: 'enter' },
    { id: 'start', label: 'Start agent', ...(running ? { off: 'running' } : {}) },
    { id: 'stop', label: 'Stop agent', ...(running ? {} : { off: 'not running' }) },
    // Whatever its rule, a person can say it is done: what waits on it starts.
    {
      id: 'mark-done',
      label: 'Mark finished',
      ...(task.finished ? { off: 'finished' } : {}),
    },
    {
      id: 'changes',
      label: 'Show changes',
      ...(changed > 0
        ? { note: `${changed} file${changed === 1 ? '' : 's'}` }
        : { off: 'none yet' }),
    },
    { id: 'rename', label: 'Rename…' },
    {
      id: 'model',
      label: 'Change model…',
      ...(!model.shown
        ? { off: `not in ${offers?.harness ?? 'this harness'}` }
        : running
          ? how
            ? { note: how }
            : {}
          : { off: 'not running' }),
    },
    // Where an account has run out of its plan: its agent goes on as another.
    {
      id: 'account',
      label: 'Run as account…',
      ...(offers && !offers.accounts ? { off: `one account in ${offers.harness}` } : {}),
    },
    { id: 'editor', label: 'Open in editor' },
    { id: 'copy-branch', label: 'Copy branch name' },
    {
      id: 'park',
      label: task.state === 'parked' ? 'Pick up again' : 'Park',
      divider: true,
    },
    { id: 'remove', label: 'Remove agent…', danger: true },
  ]
}

/**
 * The accounts an agent could run as: its harness's, the one it is on marked,
 * and one not signed in to said so — choosing it would start an agent that
 * cannot think.
 */
export function accountMenuItems(
  accounts: readonly AccountShown[],
  harness: string,
  current: string,
): MenuItem[] {
  return accounts
    .filter((one) => one.harness === harness)
    .map((one) => {
      const id = one.name ?? ''
      return {
        id,
        label: `${id === current ? '● ' : '  '}${one.name ?? 'its own sign-in'}`,
        ...(id === current
          ? { note: 'now' }
          : one.status.signedIn
            ? one.limits?.fiveHour
              ? { note: `${Math.round(one.limits.fiveHour.used)}% of 5h` }
              : {}
            : { off: 'not signed in' }),
      }
    })
}

/** Queued work's menu: start it, pause or resume it, wait past what held it, rename or remove it. */
export function queueMenuItems(queued: { state: { kind: string } }): MenuItem[] {
  const paused = queued.state.kind === 'paused'
  const held = queued.state.kind === 'held'
  return [
    { id: 'open', label: 'Open', note: 'enter' },
    { id: 'queue-start', label: 'Start now' },
    // A preference among what is ready, not a start: it waits for what it
    // waits on exactly as it did, and goes first when it can go at all.
    { id: 'queue-first', label: 'Do this one first' },
    paused ? { id: 'queue-resume', label: 'Resume' } : { id: 'queue-pause', label: 'Pause' },
    {
      id: 'queue-wait',
      label: 'Wait for a retry',
      ...(held ? {} : { off: 'not held' }),
    },
    { id: 'rename', label: 'Rename…' },
    { id: 'queue-remove', label: 'Remove', danger: true, divider: true },
  ]
}

/** A schedule's menu: open it, run it now, pause or resume it, rename or remove it. */
export function scheduleMenuItems(schedule: {
  paused: boolean
  next: readonly number[]
}): MenuItem[] {
  return [
    { id: 'schedule-open', label: 'Open', note: 'enter' },
    { id: 'schedule-run', label: 'Run now' },
    schedule.paused
      ? { id: 'schedule-resume', label: 'Resume' }
      : {
          id: 'schedule-pause',
          label: 'Pause',
          ...(schedule.next.length > 0 ? {} : { off: 'nothing left to run' }),
        },
    { id: 'schedule-rename', label: 'Rename…' },
    { id: 'schedule-remove', label: 'Remove', danger: true, divider: true },
  ]
}

/** Up and down through what can be done, enter to do it. */
export function menuKey(
  panel: MenuPanel,
  key: string | undefined,
  items: readonly MenuItem[],
): PanelOutcome {
  if (key === 'escape') return close
  const usable = items.map((item, at) => ({ item, at })).filter(({ item }) => !item.off)
  if (key === 'down' || key === 'tab' || key === 'up' || key === 'shift+tab') {
    const here = usable.findIndex(({ at }) => at === panel.index)
    const step = key === 'down' || key === 'tab' ? 1 : -1
    const next = usable[(Math.max(0, here) + step + usable.length) % Math.max(1, usable.length)]
    return stay({ ...panel, index: next?.at ?? panel.index, following: true })
  }
  if (key === 'enter') {
    const item = items[panel.index]
    return item && !item.off ? { panel, submit: true, choice: item.id } : stay(panel)
  }
  return stay(panel)
}

/** A click on an item does it; a click anywhere else on the menu does nothing. */
export function menuClick(panel: MenuPanel, control: string): PanelOutcome {
  return control.startsWith('item:')
    ? { panel, submit: true, choice: control.slice(5) }
    : stay(panel)
}
