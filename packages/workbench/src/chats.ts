import { homedir } from 'node:os'
import {
  chatName,
  chatNumberOf,
  chatTaskOf,
  type EventFilter,
  isChatLane,
  isChatTask,
  nextChatTask,
  type TadeEvent,
  type TaskId,
} from '@tade/core'
import type { HarnessSession, Offer } from '@tade/harnesses-core'
import type { LaneRecord } from './registry.ts'
import type { StartRunRequest } from './workers.ts'

// Opening a chat, and finding the ones that are open.
//
// A chat is an agent whose task is `chats/<n>` (`core/src/chat.ts` carries
// what that means), so almost nothing here is new: it goes through
// `startAgent` like every other agent, which is what puts its turns on the
// supervision channel and its spend in the journal under a task Tade can add
// up. What this file is for is the four decisions a chat makes differently,
// and keeping them in one place so every way of opening one makes them the
// same way.

/** A chat, as the window's tabs and the orchestrator's list see one. */
export interface ChatInfo {
  /** Its lane: `chats/3/agent`. What the window puts in front. */
  id: string
  /** Its task: `chats/3`. What steers and stops it. */
  task: string
  /**
   * Empty, always: a chat belongs to no project, which is why its tab is in
   * the lower pane whichever project you are standing in.
   */
  project: string
  /** `pi 1`, `codex 2`: what its tab says. */
  name: string
  cwd: string
  harness: string
  startedAt: number
  /**
   * When its tab was first opened, which a chat brought back keeps
   * (`LaneRecord.openedAt`): what the tabs are ordered by, so one reopened
   * goes back where it was rather than after every chat that stayed open.
   */
  openedAt: number
}

/** What opening a chat needs of the workbench, and nothing else. */
export interface ChatHost {
  events(filter?: EventFilter): Promise<TadeEvent[]>
  startAgent(req: StartRunRequest): Promise<LaneRecord>
}

export interface OpenChatRequest {
  /** Which agent to talk to. The default route's harness unless said. */
  harness?: string
  /** Where it stands. Your home directory unless said — see `chatCwd`. */
  cwd?: string
  /** What to say to it first. Nothing, for one opened to type into. */
  prompt?: string
}

/**
 * Where a chat stands when nobody said: your home directory.
 *
 * Not a project's checkout, which would put an agent with no task and no
 * branch in a tree other agents are committing from — the one place a stray
 * edit is indistinguishable from somebody's work. Not Tade's own home either,
 * which holds every task file, every journal and every key. Your home is
 * where a shell opens, it is yours rather than any repository's, and an agent
 * asked about this machine is already where the question is.
 */
export function chatCwd(req: Pick<OpenChatRequest, 'cwd'>): string {
  return req.cwd?.trim() || homedir()
}

/**
 * Open a chat: the one door, so the four decisions below are made once.
 *
 * **Its number comes from the journal** (`nextChatTask`), never from what is
 * running: a harness names its session after the task, so reusing a closed
 * chat's number would reopen that conversation instead of starting one. Two
 * types of event rather than the whole journal, and read once per chat opened
 * rather than per frame.
 *
 * **It is given no extension tools.** `extras: {}` rather than what the
 * extension host offers, because every tool Tade's extensions hand an agent —
 * running the project's checks, reading its review, updating its
 * dependencies, saying its task is done — is about a task's files, and a chat
 * has none. A tool that can only throw is a tool that costs a turn to
 * discover.
 *
 * **It is told it is a chat** by `composeAgentPrompt`, which reads that off
 * the task id, so this does not pass a prompt of its own and a chat reopened
 * from its lane is told the same thing.
 *
 * **It owns no files, so it has no worktree boundary** (`worktree: ''`). That
 * boundary is what makes a write *routine* instead of asked, and a chat stands
 * in your home directory: every project checkout, every key and every file you
 * have is under it. So there is no boundary at all — nothing a chat writes is
 * its own work, which is the same sentence its prompt says to it, and under
 * `policy` approvals it is asked before changing anything. Its commands are
 * still read by whoever reads commands.
 */
export async function openChat(on: ChatHost, req: OpenChatRequest = {}): Promise<ChatInfo> {
  const task = nextChatTask(await on.events({ types: ['lane_opened', 'run_started'] }))
  const cwd = chatCwd(req)
  const record = await on.startAgent({
    task: task as TaskId,
    cwd,
    worktree: '',
    prompt: req.prompt?.trim() ?? '',
    extras: {},
    ...(req.harness ? { harness: req.harness } : {}),
  })
  const opened = chatOf(record)
  // Said rather than handed back half-made: a lane that is not alive is a chat
  // that did not start, and a tab for one is a tab nothing is behind.
  if (!opened) throw new Error(`the chat did not start in ${cwd}`)
  return opened
}

/**
 * Bring a chat that was running when Tade closed back where it left off.
 *
 * Its folder comes off its own stored lane spec rather than from anything
 * that knows where tasks work, because a chat has no worktree to look up —
 * which is exactly why the window's ordinary reopen walks past it.
 */
export function reopenChat(on: ChatHost, lane: LaneRecord): Promise<LaneRecord> {
  return on.startAgent({
    task: chatTaskOf(lane.id) as TaskId,
    cwd: lane.spec.cwd,
    worktree: '',
    prompt: '',
    extras: {},
    ...(lane.harness ? { harness: lane.harness } : {}),
    ...(lane.account ? { account: lane.account } : {}),
    // Its tab goes back where it was. Chats reopened as the window opens all
    // start again at once, in no particular order, so the moment each started
    // this time says nothing about where its tab belongs.
    openedAt: lane.openedAt ?? lane.startedAt,
  })
}

/** One lane as a chat, or null when it is not one — or not running. */
function chatOf(lane: LaneRecord): ChatInfo | null {
  if (!isChatLane(lane.id) || !lane.alive) return null
  const task = chatTaskOf(lane.id)
  return {
    id: lane.id,
    task,
    project: '',
    name: chatName(task, lane.harness ?? ''),
    cwd: lane.spec.cwd,
    harness: lane.harness ?? '',
    startedAt: lane.startedAt,
    openedAt: lane.openedAt ?? lane.startedAt,
  }
}

/**
 * The chats among a registry's lanes, in the order their tabs were first
 * opened — never the order they last started in, which for chats the window
 * reopened as it opened is the order their harnesses happened to come up.
 */
export function chatsFrom(lanes: readonly LaneRecord[]): ChatInfo[] {
  return lanes
    .flatMap((lane) => chatOf(lane) ?? [])
    .sort((a, b) => a.openedAt - b.openedAt || a.id.localeCompare(b.id))
}

/** The chats that were running when Tade last closed and did not come back with it. */
export function lostChats(lanes: readonly LaneRecord[]): LaneRecord[] {
  return lanes.filter((lane) => isChatLane(lane.id) && !lane.alive && lane.lost === true)
}

// --- chats that were closed
//
// Closing a chat ends its agent and leaves its conversation where its harness
// keeps it, so one closed by accident — or on purpose and wanted again — can
// come back: the same number, the same harness, the same folder, carrying on
// the same conversation, with its tab back where it was. The journal is what
// remembers it, because the lane registry forgets a closed chat the next time
// the window opens (`forgettable`: a chat has no task file), and its harness
// is what says whether the conversation is still there.

/**
 * Said whenever a chat comes back: whatever it had running in the background
 * when it closed ended with it.
 *
 * A harness's subagents and background shells are its own process's children,
 * so they end with its lane. The conversation it comes back to still has them
 * being started and nothing saying they stopped, so anybody reading it — the
 * agent included — would wait on one for ever.
 */
export const BACKGROUND_ENDED =
  'Anything it had running in the background when it closed — a subagent, a background shell — ended with it and is not running now.'

/** What the journal says of chats: when each opened and stopped, in what, and where. */
const CHAT_EVENTS = [
  'run_started',
  'lane_opened',
  'lane_closed',
  'lane_exited',
  'run_exited',
] as const

/** A chat as the journal remembers it, before its harness is asked about its conversation. */
export interface ChatHeard {
  task: TaskId
  harness: string
  /** The account it ran as, when not its harness's own sign-in. */
  account: string | null
  cwd: string
  /** When its tab was first opened. */
  openedAt: number
  /** When it last stopped, if it has not started since; null where nothing was heard stop. */
  closedAt: number | null
}

/** A chat that is not running, whose conversation its harness still keeps. */
export interface ClosedChat {
  /** Its lane, `chats/5/agent`: the id it had, and has again once it is back. */
  id: string
  /** Its task, `chats/5`: what brings it back. */
  task: string
  /** `claude-code 5`: what its tab said. */
  name: string
  cwd: string
  harness: string
  account: string | null
  /** When its tab was first opened: where its tab goes back to. */
  openedAt: number
  /** When it stopped; null where the journal never heard it stop, as when the window closed on it. */
  closedAt: number | null
  /** The first thing said in it, on one line. */
  first: string
  /** Its harness's own id for the conversation. */
  session: string
}

/** A conversation a harness keeps for a folder that is no chat of Tade's: one somebody had there themselves. */
export interface OtherSession {
  harness: string
  account: string | null
  cwd: string
  /** The harness's own id for it, which is what carrying it into a chat takes. */
  session: string
  at: number
  first: string
}

/** What a chat can be brought back from: closed chats, a folder's other conversations, and what could not be read. */
export interface ChatSessions {
  closed: ClosedChat[]
  others: OtherSession[]
  /** A harness whose record could not be read, in words: a look that failed is not a look that found nothing. */
  problems: string[]
}

/** What bringing a chat back needs of the workbench. */
export interface ClosedChatHost extends ChatHost {
  lanes(): readonly LaneRecord[]
  /** A harness's conversations in a folder, asked of its own adapter (`WorkerAdapter.sessions`). */
  sessionsIn(req: {
    harness: string
    account?: string | null
    cwd: string
    tasks: readonly TaskId[]
  }): Promise<HarnessSession[]>
  /** Have a chat carry on one of them (`WorkerAdapter.carrySession`). */
  carrySession(req: {
    harness: string
    account?: string | null
    session: string
    task: TaskId
    cwd: string
  }): Promise<boolean>
  /** Whether a harness can come back to a conversation, as every surface offers it (`resumeOffer`). */
  resumeOf(harness: string): Offer
}

/** A text field of an event's detail, or empty. */
function said(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Every chat the journal has heard of, in the order each was first opened.
 * Pure: a fold over `CHAT_EVENTS`, oldest first, so a chat started again
 * after it stopped is not stopped any more.
 */
export function chatsHeard(events: readonly TadeEvent[]): ChatHeard[] {
  const heard = new Map<string, ChatHeard>()
  // When its lane first opened is when its tab did; until that is heard, the
  // first thing heard of it stands in.
  const tabbed = new Set<string>()
  for (const event of events) {
    const task = event.task ?? ''
    if (!isChatTask(task)) continue
    const at = Date.parse(event.ts)
    if (Number.isNaN(at)) continue
    const one = heard.get(task) ?? {
      task: task as TaskId,
      harness: '',
      account: null,
      cwd: '',
      openedAt: at,
      closedAt: null,
    }
    heard.set(task, one)
    switch (event.type) {
      case 'run_started':
        one.harness = said(event.detail.adapter) || one.harness
        one.account = said(event.detail.account) || null
        one.cwd = said(event.detail.cwd) || one.cwd
        one.closedAt = null
        break
      case 'lane_opened':
        if (event.lane !== `${task}/agent`) break
        if (!tabbed.has(task)) one.openedAt = at
        tabbed.add(task)
        one.cwd = said(event.detail.cwd) || one.cwd
        one.closedAt = null
        break
      default:
        one.closedAt = at
    }
  }
  return [...heard.values()]
    .filter((one) => one.harness !== '' && one.cwd !== '')
    .sort((a, b) => a.openedAt - b.openedAt)
}

/**
 * What a chat can be brought back from: every closed chat whose conversation
 * its harness still keeps, newest closed first, and — for each of `harnesses`
 * in each of `folders`, and in every folder a chat stood in — the other
 * conversations that harness keeps there, newest first.
 *
 * Every conversation is its harness's to find and name, asked of its own
 * adapter: nothing here reads a harness's store. A harness that cannot come
 * back to one (`resumeOffer`) is not asked, and offers none.
 */
export async function chatSessions(
  on: ClosedChatHost,
  opts: { harnesses?: readonly string[]; folders?: readonly string[] } = {},
): Promise<ChatSessions> {
  const heard = chatsHeard(await on.events({ types: CHAT_EVENTS }))
  const open = new Set(
    on
      .lanes()
      .filter((lane) => isChatLane(lane.id) && lane.alive)
      .map((lane) => chatTaskOf(lane.id)),
  )
  const problems: string[] = []
  const resumes = (harness: string): boolean => {
    try {
      return on.resumeOf(harness).shown
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err))
      return false
    }
  }
  // One question per harness, account and folder, carrying every chat that
  // stood there, so its harness names which of its conversations each one's is.
  const asks = new Map<string, { harness: string; account: string | null; cwd: string }>()
  const chatsAt = new Map<string, ChatHeard[]>()
  const keyOf = (harness: string, account: string | null, cwd: string) =>
    JSON.stringify([harness, account, cwd])
  for (const harness of new Set([...(opts.harnesses ?? []), ...heard.map((one) => one.harness)])) {
    if (!resumes(harness)) continue
    for (const cwd of opts.harnesses?.includes(harness) ? (opts.folders ?? []) : []) {
      asks.set(keyOf(harness, null, cwd), { harness, account: null, cwd })
    }
  }
  for (const one of heard) {
    if (!resumes(one.harness)) continue
    const key = keyOf(one.harness, one.account, one.cwd)
    asks.set(key, { harness: one.harness, account: one.account, cwd: one.cwd })
    chatsAt.set(key, [...(chatsAt.get(key) ?? []), one])
  }
  const closed: ClosedChat[] = []
  const others: OtherSession[] = []
  await Promise.all(
    [...asks].map(async ([key, ask]) => {
      const chats = chatsAt.get(key) ?? []
      let sessions: HarnessSession[]
      try {
        sessions = await on.sessionsIn({ ...ask, tasks: chats.map((one) => one.task) })
      } catch (err) {
        problems.push(
          `could not read ${ask.harness}'s conversations in ${ask.cwd}: ${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }
      for (const session of sessions) {
        const chat = session.task ? chats.find((one) => one.task === session.task) : undefined
        if (!chat) {
          if (!session.task)
            others.push({ ...ask, session: session.id, at: session.at, first: session.first })
          continue
        }
        if (open.has(chat.task)) continue
        closed.push({
          id: `${chat.task}/agent`,
          task: chat.task,
          name: chatName(chat.task, chat.harness),
          cwd: chat.cwd,
          harness: chat.harness,
          account: chat.account,
          openedAt: chat.openedAt,
          closedAt: chat.closedAt,
          first: session.first,
          session: session.id,
        })
      }
    }),
  )
  const when = (one: ClosedChat) => one.closedAt ?? one.openedAt
  return {
    closed: closed.sort((a, b) => when(b) - when(a) || b.task.localeCompare(a.task)),
    others: others.sort((a, b) => b.at - a.at),
    problems,
  }
}

/** A chat named the ways a person or a list names one — `chats/5`, `chats/5/agent`, `5`, `claude-code 5` — as its task. */
export function chatTaskNamed(name: string): TaskId | null {
  const trimmed = name.trim()
  const number = chatNumberOf(trimmed) ?? Number(/(?:^|\s)(\d+)$/.exec(trimmed)?.[1] ?? Number.NaN)
  return Number.isInteger(number) && number > 0 ? (`chats/${number}` as TaskId) : null
}

/**
 * Bring a closed chat back: its own number, in the harness and folder it ran
 * in, carrying on the conversation its harness kept, with its tab back where
 * it was. Nothing is said to it — what it was asked was asked once.
 *
 * Refused, in words, for a chat that is open already, one that never was, one
 * whose harness cannot come back to a conversation (its own sentence why), and
 * one whose harness no longer keeps the conversation — never started over
 * under the old number as though it had been brought back.
 */
export async function reopenClosedChat(
  on: ClosedChatHost,
  name: string,
): Promise<{ chat: ChatInfo; said: string }> {
  const task = chatTaskNamed(name)
  if (!task) throw new Error(`${name} is not a chat: a chat is named by its number, like chats/5`)
  if (on.lanes().some((lane) => lane.id === `${task}/agent` && lane.alive)) {
    throw new Error(`${task} is open already`)
  }
  const heard = chatsHeard(await on.events({ types: CHAT_EVENTS })).find((one) => one.task === task)
  if (!heard) throw new Error(`no chat called ${task} was ever opened here`)
  const offered = on.resumeOf(heard.harness)
  if (!offered.shown) throw new Error(`${task} ran in ${heard.harness}, which ${offered.note}`)
  const kept = await on.sessionsIn({
    harness: heard.harness,
    account: heard.account,
    cwd: heard.cwd,
    tasks: [task],
  })
  if (!kept.some((one) => one.task === task)) {
    throw new Error(
      `${heard.harness} no longer keeps ${task}'s conversation, so there is nothing to bring back: open a new chat instead`,
    )
  }
  const record = await on.startAgent({
    task,
    cwd: heard.cwd,
    worktree: '',
    prompt: '',
    extras: {},
    harness: heard.harness,
    ...(heard.account ? { account: heard.account } : {}),
    openedAt: heard.openedAt,
  })
  const chat = chatOf(record)
  if (!chat) throw new Error(`${task} did not start again in ${heard.cwd}`)
  return { chat, said: BACKGROUND_ENDED }
}

/**
 * Open a chat that carries on a conversation its harness keeps for a folder
 * and no chat of Tade's is (`OtherSession`): a new number, made to come back
 * to that conversation by its harness (`carrySession`) before its first
 * launch, and then opened like any other chat with nothing said to it.
 */
export async function chatFromSession(
  on: ClosedChatHost,
  req: { harness: string; account?: string | null; cwd: string; session: string },
): Promise<{ chat: ChatInfo; said: string }> {
  const offered = on.resumeOf(req.harness)
  if (!offered.shown) throw new Error(`${req.harness} ${offered.note}`)
  const task = nextChatTask(await on.events({ types: ['lane_opened', 'run_started'] })) as TaskId
  if (!(await on.carrySession({ ...req, task }))) {
    throw new Error(`${req.harness} has no conversation ${req.session} in ${req.cwd}`)
  }
  const record = await on.startAgent({
    task,
    cwd: req.cwd,
    worktree: '',
    prompt: '',
    extras: {},
    harness: req.harness,
    ...(req.account ? { account: req.account } : {}),
  })
  const chat = chatOf(record)
  if (!chat) throw new Error(`the chat did not start in ${req.cwd}`)
  return { chat, said: BACKGROUND_ENDED }
}
