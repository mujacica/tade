import { pageBy } from '../frame.ts'
import { close, type PanelOutcome, stay } from '../outcome.ts'

// One request from outside this machine, in front of you.
//
// A row down the side says its id and where it stands, because a side
// twenty-eight columns wide has nothing more. This is the page that answers
// the rest: who asked, which key allowed it, which published template version
// it was stamped from, what approving it would start — and then **the request
// itself**, under a label saying whose words those are.
//
// **It holds no content of its own.** What is in it comes from the journal,
// the task files and the context file Tade wrote, asked once when the panel
// opens (`PanelContext.intake`), so reopening it on the same row gets a fresh
// answer rather than a remembered one. The body in particular is read from the
// context file and from nowhere else: Tade keeps no second copy of a
// stranger's words.
//
// **Approving asks, and it is the only button that does.** `escapeMeans` is
// always exactly one thing, so a key that would start three agents is not a
// key that also means yes — and the question says how many agents and whose
// money, because that is what a person is actually deciding.

export interface IntakePanel {
  kind: 'intake'
  /** `<source>:<externalId>` — the thing itself, across every revision. */
  item: string
  /** What the row called itself, so the box has a name from the first frame. */
  title: string
  scroll: number
  /** It is being read, or an act is going. */
  busy: boolean
  /** What it last said: an act's own sentence. */
  said: string | null
  /** Why there is nothing to show, or why an act was refused. */
  problem: string | null
  /**
   * A question waiting for an answer, because carrying it out is not
   * reversible: starting agents, and refusing a request somebody is waiting
   * on. Null the rest of the time, which is most of the time.
   */
  asking: 'approve' | 'start' | 'refuse' | null
}

export function intakePanel(item: string, title: string): IntakePanel {
  return {
    kind: 'intake',
    item,
    title,
    scroll: 0,
    busy: true,
    said: null,
    problem: null,
    asking: null,
  }
}

/**
 * The acts this page offers, by the key and the control both reaching them.
 *
 * Four, and not a fifth for opening it at its source: where the request lives
 * is drawn as the link it is, in the body, and clicking a url is the window's
 * own act everywhere else. A button that duplicated a link would be a second
 * door to the same place.
 */
const ACTS: Readonly<Record<string, IntakePanel['asking'] | 'retry'>> = {
  a: 'approve',
  s: 'start',
  r: 'refuse',
  t: 'retry',
}

/**
 * A key, while this page has the keyboard.
 *
 * One letter per act, as research asks and as the window's own rule allows
 * here: a panel has the keyboard while it is open, so a letter is not a letter
 * typed at an agent. The arrows read down the page, which is what it is mostly
 * for.
 */
export function intakeKey(panel: IntakePanel, key: string | undefined, data: string): PanelOutcome {
  if (panel.asking) {
    // Escape answers the question and nothing else: it is always exactly one
    // thing, and here that thing is "no".
    if (key === 'escape' || key === 'n') return stay({ ...panel, asking: null })
    if (key === 'enter' || key === 'y') {
      return { panel: { ...panel, busy: true, asking: null }, submit: true, choice: panel.asking }
    }
    return stay(panel)
  }
  if (key === 'escape') return close
  if (panel.busy) return stay(panel)
  const act = ACTS[data.toLowerCase()]
  if (act === 'retry') return { panel: { ...panel, busy: true }, submit: true, choice: 'retry' }
  if (act) return stay({ ...panel, asking: act, said: null, problem: null })
  const by = pageBy(key)
  return by === null ? stay(panel) : stay({ ...panel, scroll: Math.max(0, panel.scroll + by) })
}

export function intakeClick(panel: IntakePanel, control: string): PanelOutcome {
  if (control === 'close') return close
  if (control === 'no') return stay({ ...panel, asking: null })
  if (control === 'yes' && panel.asking) {
    return { panel: { ...panel, busy: true, asking: null }, submit: true, choice: panel.asking }
  }
  if (panel.busy) return stay(panel)
  if (control === 'approve' || control === 'start' || control === 'refuse') {
    return stay({ ...panel, asking: control, said: null, problem: null })
  }
  if (control === 'retry') {
    return { panel: { ...panel, busy: true }, submit: true, choice: 'retry' }
  }
  return stay(panel)
}
