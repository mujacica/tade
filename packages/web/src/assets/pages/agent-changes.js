// One agent's changes — the window's Show changes, from away: every file in
// its CHANGES section's order, each with the whole of its diff from its first
// hunk. Nothing is cut; a file git did not answer for says so on its card, and
// a long line scrolls inside its card, never the page. **Asked when the screen
// opens and on a press, never on a beat** (a diff is git asked per file), on
// `lanes` (`changes.ts`), `no-store`, so no copy is kept on this device.

import { el, into, skeleton, textIn } from '../dom.js'
import { icon } from '../icons.js'
import { pathOf } from '../routes.js'
import { pageBar } from '../rows.js'
import { troubleOf, troubleSaid, UNKNOWN_TROUBLE } from '../trouble.js'
import { panel, stateBox, stateBoxIn } from '../ui.js'
import {
  countSaid,
  diffRows,
  figureOf,
  fileSaid,
  markWord,
  stateFor,
  takenSaid,
} from './agent-changes-shape.js'

/** How long after a `not looked` answer the screen asks again by itself, once. */
const AGAIN_MS = 1_500

export function changesScreen(where, ctx) {
  const live = ctx !== undefined && ctx !== null
  const node = el('div', { class: 'ag-changes' })
  const bar = pageBar('Changes', {
    back: {
      text: where.task,
      href: pathOf({ view: 'task', project: where.project, task: where.task }),
    },
  })
  const again = el('button', {
    class: 'tap icon',
    attrs: { type: 'button', 'aria-label': 'Read its changes again' },
  })
  into(again, icon('refresh'))
  into(bar.tools, again)
  const coming = el('div', { class: 'ag-coming' })
  into(coming, skeleton(3), skeleton(8))
  const why = stateBox()
  const list = el('div', { class: 'ag-files' })
  into(node, bar.node, coming, why, list)

  const path = `/api/agent/${encodeURIComponent(where.project)}/${encodeURIComponent(where.task)}/changes`
  let answer = null
  let failed = null
  let asking = false
  let gone = false
  let retried = false
  let timer = null

  const draw = () => {
    coming.hidden = answer !== null || failed !== null
    textIn(bar.figure, figureOf(answer))
    // A failed ask after a good one keeps the files under it: what is drawn is the last thing true.
    const state = failed !== null ? stateFor(null, failed) : stateFor(answer, null)
    stateBoxIn(
      why,
      state === null
        ? null
        : {
            ...state,
            action:
              state.kind === 'error' ? { word: 'Read again', run: () => void ask() } : undefined,
          },
    )
    list.hidden = answer === null || answer.says !== 'files'
    if (!list.hidden) list.replaceChildren(...answer.files.map(fileCard))
  }

  const ask = async () => {
    if (asking || gone || !live) return
    asking = true
    again.setAttribute('aria-busy', 'true')
    const got = await ctx.ask('GET', path)
    asking = false
    again.removeAttribute('aria-busy')
    if (gone) return
    if (got.status === 200 && got.body !== null && got.body.v === 1) {
      answer = got.body
      failed = null
    } else {
      failed = troubleSaid(troubleOf(got) ?? UNKNOWN_TROUBLE)
    }
    draw()
    // The machine had not looked at its tree yet: once more in a moment, by itself.
    if (answer?.says === 'not looked' && !retried) {
      retried = true
      timer = setTimeout(() => void ask(), AGAIN_MS)
    }
  }
  again.addEventListener('click', () => {
    retried = false
    void ask()
  })
  draw()
  void ask()

  return {
    node,
    update() {},
    leave() {
      gone = true
      if (timer !== null) clearTimeout(timer)
    },
  }
}

/** One file: its path and what git calls it, its counts, and every line of its diff. */
function fileCard(file) {
  const card = panel('section', 'ag-file')
  const head = el('div', { class: 'ag-file-head' })
  into(
    head,
    el('span', {
      class: `ag-file-mark is-${file.mark === '?' ? 'A' : file.mark}`,
      text: markWord(file.mark),
    }),
    el('span', { class: 'ag-file-path', text: file.path }),
    el('span', { class: 'ag-file-count', text: countSaid(file.added, file.removed) }),
  )
  into(card, head)
  const instead = fileSaid(file)
  if (instead !== null) {
    into(card, el('p', { class: 'ag-file-none', text: instead }))
  } else {
    const frame = el('div', {
      class: 'scrolls ag-diff',
      attrs: { role: 'region', 'aria-label': `What changed in ${file.path}`, tabindex: '0' },
    })
    const pre = el('pre')
    for (const row of diffRows(file.text)) {
      into(
        pre,
        el('span', { class: `ag-line is-${row.kind}`, text: row.line === '' ? ' ' : row.line }),
      )
    }
    into(frame, pre)
    into(card, frame)
  }
  const taken = takenSaid(file)
  if (taken !== null) into(card, el('p', { class: 'ag-file-foot', text: taken }))
  return card
}
