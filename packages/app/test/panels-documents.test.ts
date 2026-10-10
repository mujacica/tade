import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { drawPanel, type PanelContext } from '../src/panels/context.ts'
import { closeDonePanel, confirmRemovePanel } from '../src/panels/small/state.ts'
import { COLOUR } from '../src/skin.ts'

// What somebody is told before they destroy a document nobody has read.
//
// Its own file because `panels.test.ts` is at the size a file is allowed to
// be, and because this is one subject rather than a page: the two questions
// that stand between a cleanup and a loss.
//
// **The bug these exist for.** Closing an agent asked nothing at all when the
// agent worked in the project's own checkout, on the strength of a comment
// saying it "loses nothing by going — only its task folder goes with it". The
// task folder is the only copy of what the task produced. On the machine this
// was found on, twelve of thirteen produced documents had been destroyed that
// way: six inside two seconds of one press of the close-everything button, and
// one of them twenty-six seconds after its agent wrote it.
//
// Both questions **ask** and neither refuses. A document is somebody's to keep
// or to throw away; what was wrong was doing it without telling them.

const context = (): PanelContext =>
  ({
    width: 110,
    height: 30,
    skin: COLOUR,
    pointer: { hover: null, pressed: null },
    changes: [],
    ahead: null,
    branch: null,
    base: null,
  }) as unknown as PanelContext

const drawn = (panel: Parameters<typeof drawPanel>[0]): string =>
  drawPanel(panel, context())
    .panel.rows.map((row) => stripTerminalSequences(row))
    .join('\n')

describe('the question before one agent is closed', () => {
  it('names the document and says the removal deletes it', () => {
    const panel = confirmRemovePanel('app/scope-audit', 'AUDIT.md (41 KB) — nobody has read it yet')
    // Keep is where the keyboard starts: enter answers the way that loses nothing.
    expect(panel.field).toBe('keep')
    const text = drawn(panel)
    expect(text).toContain('It produced a document nobody has read')
    expect(text).toContain('AUDIT.md (41 KB)')
    expect(text).toContain('Deletes the worktree, the branch and that document')
    // Still a question: the destructive answer is there to be chosen.
    expect(text).toContain('Remove anyway')
  })

  it('says nothing of the sort where closing loses no document', () => {
    const text = drawn(confirmRemovePanel('app/refunds'))
    expect(text).not.toContain('nobody has read')
    expect(text).toContain('Deletes the worktree and branch')
  })
})

describe('the question before every finished agent is closed at once', () => {
  it('counts the ones carrying an unread document, before the press', () => {
    const panel = closeDonePanel(
      ['app/shipped', 'app/scope-audit', 'app/lake-parity'],
      ['app/scope-audit', 'app/lake-parity'],
    )
    expect(panel.field).toBe('keep')
    const text = drawn(panel)
    expect(text).toContain('2 produced a document nobody has read')
    // And marked in the list itself, so it is clear *which* two.
    expect(text).toContain('document unread')
  })

  it('says nothing where none of them produced one', () => {
    const text = drawn(closeDonePanel(['app/shipped', 'app/reviewed']))
    expect(text).not.toContain('nobody has read')
  })
})
