import { pageBy } from '../frame.ts'
import { close, type PanelOutcome, stay } from '../outcome.ts'

// One row of a list, in front of you.
//
// A row down the side says what it is in two rows and nothing more, because a
// side twenty-eight columns wide has nothing more. Clicking one used to run the
// extension's own tool and drop its markdown into the conversation — which is
// the right answer for a model and the wrong one for somebody who just wanted
// to look at a review: the page you were on went away, and what came back was
// a wall of prose in a transcript.
//
// So a click opens this instead: the same facts as marks and figures, grouped,
// in the shell every other panel is drawn in. Asking the conversation about it
// is still one button, and it is now a thing somebody chose rather than the
// only thing a click could do.
//
// It holds no content of its own. What is in it comes from the extension that
// keeps the row (`PanelContext.summary`), asked once when the panel opens, so
// the panel can be reopened on the same row and get a fresh answer.

export interface RowSummaryPanel {
  kind: 'row-summary'
  /** The list it came from: `<extension>.<list>`. */
  section: string
  /** Its own id in that list, which is what the extension is asked about. */
  row: string
  /**
   * What the row called itself, so the box has a name from the first frame.
   * The answer's own title replaces it the moment it arrives.
   */
  title: string
  /** Where it goes when its link is pressed, from the row rather than the answer. */
  url: string | null
  scroll: number
  /** It is being asked. The page says so rather than looking empty. */
  busy: boolean
  /** Why there is nothing to show, when the ask failed. */
  problem: string | null
}

export function rowSummaryPanel(
  section: string,
  row: string,
  title: string,
  url: string | null = null,
): RowSummaryPanel {
  return { kind: 'row-summary', section, row, title, url, scroll: 0, busy: true, problem: null }
}

/** Nothing to answer: it reads, and the arrows read down it. */
export function rowSummaryKey(panel: RowSummaryPanel, key: string | undefined): PanelOutcome {
  if (key === 'escape') return close
  const by = pageBy(key)
  return by === null ? stay(panel) : stay({ ...panel, scroll: Math.max(0, panel.scroll + by) })
}

export function rowSummaryClick(panel: RowSummaryPanel, control: string): PanelOutcome {
  if (control === 'close') return close
  // Both of these are acts the row itself could already do, kept as acts: the
  // one that leaves Tade, and the one that puts it to the orchestrator.
  if (control === 'open' || control === 'ask') return { panel, submit: true, choice: control }
  return stay(panel)
}
