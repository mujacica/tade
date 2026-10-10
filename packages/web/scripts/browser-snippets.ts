// The snippets the harness hands a browser, and nothing else.
//
// **Strings, deliberately, and in their own file for the same reason.** They
// execute in a page, where `document` exists and this repository's `lib` has no
// DOM; written as closures they would be code `tsc` has to pretend to
// understand. As strings they are what they are — a payload handed over the
// debugger protocol — and keeping them here leaves `browser.ts` as the thing
// that drives a browser rather than a file half made of another language.
//
// None of them changes anything about the page. Each reads what is on it and
// answers a value: which controls are drawn, what the landmarks are, what is
// focused, what is selected, what axe found.

/** Which controls are drawn, which reasons are, and which targets are too small. */
export const CONTROLS = `(() => {
  const NAMED = {
    'SET ASIDE': 'park',
    'TELL ITS AGENT': 'steer',
    'FINISHED': 'done',
    'A NOTE': 'note',
    'WHAT IT IS TOLD': 'context',
    'WAITING ON YOU': 'answer',
    'IN THE QUEUE': 'queue',
    'FROM OUTSIDE': 'intake',
  }
  const drawn = []
  const reasons = []
  const small = []
  for (const part of document.querySelectorAll('main .section')) {
    const head = (part.querySelector('h2')?.textContent || '').trim()
    const press = [...part.querySelectorAll('button')].filter((one) => one.offsetParent !== null)
    const why = [...part.querySelectorAll('.empty')].filter(
      (one) => one.offsetParent !== null && (one.textContent || '').trim() !== '',
    )
    if (!(head in NAMED)) continue
    if (press.length > 0) drawn.push(head)
    if (why.length > 0 && press.length === 0) reasons.push(head)
    for (const one of press) {
      const box = one.getBoundingClientRect()
      if (box.height < 44 || box.width < 44) {
        small.push(head + ': ' + Math.round(box.width) + 'x' + Math.round(box.height))
      }
    }
  }
  return {
    drawn: drawn.map((one) => NAMED[one]).filter(Boolean),
    reasons: reasons.map((one) => NAMED[one]).filter(Boolean),
    small,
  }
})()`

/** That some control answered at all. */
export const SAID_SOMETHING = `[...document.querySelectorAll('main [role="status"]')].some(
  (one) => (one.textContent || '').includes('done')
)`

/**
 * Everything on the page that is a status, as text.
 *
 * **What this is for has one shape**: a node that carries both what came of
 * the last press and a fact about the harness that is true on every frame. The
 * delta two seconds later rewrites the second and takes the first with it, so
 * somebody taps, reads an answer, and watches it turn into a sentence they had
 * already read. Read twice across a wait longer than a beat, and compared —
 * rather than matched against a word, which would be a check against whatever
 * this harness's stand-in happens to answer.
 */
export const STATUS = `[...document.querySelectorAll('main [role="status"]')]
  .map((one) => (one.textContent || '').trim())
  .filter((one) => one !== '')
  .join(' | ')`

/** That the note control was refused, in Tade's own sentence. */
export const SAID_MOVED = `[...document.querySelectorAll('main [role="status"]')].some(
  (one) => (one.textContent || '').includes('changed while you were looking')
)`

/**
 * Everything about one screen that only a laid-out page can answer.
 *
 * One snippet rather than four, because four would mean four layout passes of
 * the same page and the answers would be about four different moments.
 */
export const SHAPE = `(() => {
  const small = []
  for (const one of document.querySelectorAll('a, button')) {
    const box = one.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) continue
    // A link inside somebody's own words is text, not a target.
    if (one.closest('.said') !== null) continue
    if (box.height < 44 || box.width < 24) {
      small.push(one.tagName.toLowerCase() + '.' + one.className + ' ' +
        Math.round(box.width) + '×' + Math.round(box.height))
    }
  }
  const first = document.querySelector('a, button')
  return {
    words: document.body.innerText || '',
    landmarks: [...document.querySelectorAll('header, nav[aria-label], main')]
      .map((one) => one.tagName.toLowerCase()),
    mains: document.querySelectorAll('main').length,
    live: document.querySelectorAll('[aria-live]').length,
    skip: first === null ? '' : (first.textContent || ''),
    sideways: document.scrollingElement ? document.scrollingElement.scrollWidth : 0,
    room: window.innerWidth,
    small,
  }
})()`

/**
 * axe, on the page as it stands, and **serious or critical only**.
 *
 * A harness that failed on every `moderate` is one somebody turns off. What is
 * asked here is the half that is not a matter of taste.
 */
export const AXE = `axe.run({ runOnly: { type: 'tag',
  values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }).then((answer) =>
  answer.violations
    .filter((one) => one.impact === 'serious' || one.impact === 'critical')
    .map((one) => ({ id: one.id, impact: one.impact, nodes: one.nodes.length,
      at: one.nodes.map((node) => node.target.join(' ')).slice(0, 2).join(', ') })))`

/** Focus a row and select inside it, and say which row and what was selected. */
export const HOLD = `(() => {
  const rows = [...document.querySelectorAll('main .rows li > a')]
  const one = rows[1] || rows[0]
  if (!one) return { key: '', words: '' }
  one.focus()
  const name = one.querySelector('.name')
  const range = document.createRange()
  range.selectNodeContents(name || one)
  const picked = window.getSelection()
  picked.removeAllRanges()
  picked.addRange(range)
  return {
    key: one.closest('li').getAttribute('data-key') || '',
    words: String(picked),
  }
})()`

/**
 * The page has drawn the reason the delta carried.
 *
 * **An expression and not a function**, like every other snippet here: they go
 * through `evaluate`, which needs no `eval` in the page — and the content
 * policy has no `unsafe-eval`, so `waitForFunction`, which polls by compiling
 * a string, cannot be used against this page at all.
 */
export const RECEIVED = `document.body.innerText.includes('moved under your hands')`

/** What is focused and selected now. */
export const HOLD_AGAIN = `(() => {
  const on = document.activeElement
  const row = on && on.closest ? on.closest('li') : null
  return {
    key: row ? row.getAttribute('data-key') || '' : '',
    words: String(window.getSelection()),
    rows: document.querySelectorAll('main .rows li').length,
  }
})()`
