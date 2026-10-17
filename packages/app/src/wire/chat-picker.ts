import { HARNESS_CHOICES } from '@tade/core'
import { inTime } from '@tade/web'
import {
  type ChatInfo,
  type ChatSessions,
  chatCwd,
  chatFromSession,
  chatSessions,
  reopenClosedChat,
} from '@tade/workbench'
import { type ChatRow, type ChatsPanel, type ChatsView, chatsPanel } from '../panels/chats/state.ts'
import { flash, notify, tilde, type Wiring, why } from './context.ts'

// Bringing a chat back from the lower pane: the chats that were closed whose
// harness kept the conversation, and the other conversations each harness
// keeps for the folder a chat opens in — your home, unless it was told
// otherwise (`chatCwd`). Every one of them is asked of its harness's own
// adapter, through the workbench (`chatSessions`); nothing here reads a
// harness's store. Choosing one is the same act the orchestrator's
// `tade_chat_reopen` is, through the same door (`reopenClosedChat`).

/**
 * How long the harnesses are given to say what they keep before the panel
 * says they did not. Reading a folder's newest conversations and their first
 * lines takes milliseconds; this is for a disk that has stopped answering.
 */
const LOOK_MS = 10_000

/** A closed chat's key, or another conversation's: what a row is asked for by. */
function keyOf(one: ChatSessions['closed'][number] | ChatSessions['others'][number]): string {
  return 'task' in one
    ? `closed:${one.task}`
    : `other:${JSON.stringify([one.harness, one.account, one.cwd, one.session])}`
}

export class ChatPicker {
  private readonly wire: Wiring
  /** Put a chat's tab in front, once it is open. */
  private readonly show: (id: string) => Promise<void>
  private found: ChatSessions | null = null
  private looking = false
  /** Which look is the latest: an older one that answers late is not the list. */
  private asked = 0

  constructor(wire: Wiring, show: (id: string) => Promise<void>) {
    this.wire = wire
    this.show = show
  }

  /** Open the panel, and ask every harness again what it keeps. */
  open(): void {
    this.wire.put({ ...this.wire.state, panel: chatsPanel() })
    this.wire.draw()
    void this.look()
  }

  private async look(): Promise<void> {
    const ask = ++this.asked
    this.looking = true
    const harnesses = HARNESS_CHOICES.filter((one) => one.ready).map((one) => one.id)
    let found: ChatSessions
    try {
      found = (await inTime(
        chatSessions(this.wire.opts.client, { harnesses, folders: [chatCwd({})] }),
        LOOK_MS,
        null,
      )) ?? {
        closed: [],
        others: [],
        problems: [`the harnesses did not say within ${LOOK_MS / 1000} s what they keep`],
      }
    } catch (err) {
      found = { closed: [], others: [], problems: [why(err)] }
    }
    if (ask !== this.asked) return
    this.found = found
    this.looking = false
    this.wire.draw()
  }

  /** What the panel draws. */
  view(): ChatsView {
    return { looking: this.looking, rows: this.rows(), problems: this.found?.problems ?? [] }
  }

  /** The rows, in the order the keyboard walks them: closed chats, then the others. */
  rows(): ChatRow[] {
    const found = this.found
    if (!found) return []
    const titled = (harness: string) =>
      HARNESS_CHOICES.find((one) => one.id === harness)?.title ?? harness
    return [
      ...found.closed.map((one) => ({
        key: keyOf(one),
        kind: 'closed' as const,
        name: one.name,
        cwd: tilde(one.cwd),
        at: one.closedAt,
        first: one.first,
      })),
      ...found.others.map((one) => ({
        key: keyOf(one),
        kind: 'other' as const,
        name: titled(one.harness),
        cwd: tilde(one.cwd),
        at: one.at,
        first: one.first,
      })),
    ]
  }

  /**
   * Bring back the one chosen: a closed chat on its own number, or another
   * conversation as a new chat carrying it on. Its tab is put in front and
   * the panel goes; what went wrong is put back in the panel, not behind it.
   */
  async choose(panel: ChatsPanel, key: string): Promise<void> {
    const found = this.found
    const closed = found?.closed.find((one) => keyOf(one) === key)
    const other = found?.others.find((one) => keyOf(one) === key)
    const client = this.wire.opts.client
    let back: { chat: ChatInfo; said: string }
    try {
      if (closed) back = await reopenClosedChat(client, closed.task)
      else if (other) back = await chatFromSession(client, other)
      else throw new Error('that one is not in the list any more')
    } catch (err) {
      this.wire.put({ ...this.wire.state, panel: { ...panel, busy: false, error: why(err) } })
      this.wire.draw()
      return
    }
    this.wire.put({ ...this.wire.state, panel: null })
    await this.show(back.chat.id)
    // Said twice: for a moment where you are looking, which is its tab, and
    // in the conversation, where it stays — what it ran in the background did
    // not come back, and nothing on its own screen will say so.
    notify(this.wire, `${back.chat.name} is back on its conversation. ${back.said}`)
    flash(
      this.wire,
      `${back.chat.name} is back on its conversation — what it ran in the background did not come back`,
    )
    this.wire.draw()
  }
}
