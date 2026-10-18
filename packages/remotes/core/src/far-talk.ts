import {
  type EventType,
  presenceLineDue,
  presentBefore,
  type SinceItem,
  sinceHere,
  type TadeEvent,
} from '@tade/core'
import {
  type ChatIn,
  chatRev,
  type Device,
  Moved,
  NotThere,
  reachOf,
  type SinceAnswer,
  sinceAnswerOf,
  type TalkIn,
  type WebAsking,
} from '@tade/web'

// The far end's orchestrator and its journal: what another machine's window
// would hold of its conversation, what it does when an owner says something to
// it, and the catch-up it folds from its own presence lines. For the window's
// tests of another machine's orchestrator tab.
//
// **The conversation is the real window's rules, scripted.** A message is
// refused unless it was written against the conversation as it stands
// (`chatRev`), and refused while a turn is in flight, exactly as the window's
// `webAsking` refuses it; a message taken is a line of the device's and a turn
// begun, which only `reply` ends. **The catch-up is the real fold**
// (`presentBefore`, `sinceHere`, `sinceAnswerOf`) over a journal a test writes
// lines into, with a presence line written the way the window writes one — so
// the card a window draws is the card a machine with that journal would send.

/** One message an owner sent, as the window there was handed it. */
export interface FarSaid {
  said: string
  device: string
  /** Whether it came in on that machine's own door, which is what makes it an owner's turn. */
  here: boolean
  /** Whether the sending machine said the person typed it there (`AskCall.typed`). */
  typed?: true
}

export class FarTalk {
  readonly lines: ChatIn[] = []
  /** What was said to it, oldest first. */
  readonly said: FarSaid[] = []
  /** What its journal holds of what the catch-up reads, oldest first. A test adds lines here. */
  readonly journal: TadeEvent[] = []
  /** The cuts the catch-up was asked from, in this clock. */
  readonly cuts: number[] = []
  /** What is waiting on the person there now, for the card. A test sets it. */
  waiting: SinceItem[] = []
  busy = false
  private whose = ''
  private count = 0
  private lineAt: number | null = null

  /** Its conversation, as the window there hands it to the projection. */
  input(): TalkIn {
    return {
      lines: this.lines,
      rev: chatRev({ busy: this.busy }),
      busy: this.busy,
      whose: this.whose,
      mine: true,
    }
  }

  /** Its orchestrator answers the turn in flight, and the turn is over. */
  reply(text: string): void {
    this.line('reply', text, '')
    this.busy = false
    this.whose = ''
  }

  /** A line of its journal, written at `at` in this clock. */
  wrote(type: EventType, task: string | null, detail: Record<string, unknown>, at: number): void {
    this.journal.push({
      seq: this.journal.length + 1,
      ts: new Date(at).toISOString(),
      type,
      urgency: 'routine',
      task,
      lane: null,
      run: null,
      detail,
    })
  }

  /** An owner's link said a key was pressed at `at`: written down once a stretch, as the window does. */
  present(device: string, at: number, now: number): void {
    if (!presenceLineDue(this.lineAt, now - at, now)) return
    this.lineAt = now
    this.wrote('person_present', null, { device }, now)
  }

  /** The window's half of `/api/since`: the real fold over this journal. */
  since(device: Device, cut: number, now: number): SinceAnswer {
    this.cuts.push(cut)
    const since = presentBefore(this.journal, cut)
    const here = since === null ? null : sinceHere(this.journal, since, now)
    return sinceAnswerOf(here, this.waiting, reachOf(device))
  }

  /** What an owner may say to it, by the window's own rules. */
  asking(): WebAsking {
    return {
      unlocked: () => true,
      ask: async (call, from, here) => {
        const rev = chatRev({ busy: this.busy })
        if (call.was !== rev) throw new Moved('Tade is already answering something', rev)
        const device = from.how === 'remote' ? from.device : ''
        this.said.push({ said: call.said, device, here, ...(call.typed ? { typed: true } : {}) })
        this.line('asked', call.said, `device ${device}`)
        this.busy = true
        this.whose = `device ${device}`
        return { did: true, rev: chatRev({ busy: true }), said: 'Tade is answering' }
      },
      stop: async (call) => {
        const rev = chatRev({ busy: this.busy })
        if (call.was !== rev) throw new Moved('the conversation moved on', rev)
        if (!this.busy) throw new NotThere('nothing is in flight to stop')
        this.busy = false
        this.whose = ''
        this.line('tade', 'stopped', '')
        return { did: true, rev: chatRev({ busy: false }), said: 'stopped it' }
      },
    }
  }

  private line(kind: ChatIn['kind'], text: string, from: string): void {
    this.count += 1
    this.lines.push({
      id: `l${String(this.count).padStart(4, '0')}`,
      at: Date.now(),
      kind,
      from,
      text,
      tool: '',
      outcome: '',
      streaming: false,
    })
  }
}
