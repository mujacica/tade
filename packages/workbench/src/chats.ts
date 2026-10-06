import { homedir } from 'node:os'
import {
  chatName,
  chatTaskOf,
  type EventFilter,
  isChatLane,
  nextChatTask,
  type TadeEvent,
  type TaskId,
} from '@tade/core'
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
  }
}

/** The chats among a registry's lanes, oldest first: the order their tabs were opened in. */
export function chatsFrom(lanes: readonly LaneRecord[]): ChatInfo[] {
  return lanes
    .flatMap((lane) => chatOf(lane) ?? [])
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}

/** The chats that were running when Tade last closed and did not come back with it. */
export function lostChats(lanes: readonly LaneRecord[]): LaneRecord[] {
  return lanes.filter((lane) => isChatLane(lane.id) && !lane.alive && lane.lost === true)
}
