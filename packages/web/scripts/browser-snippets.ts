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

/**
 * Every animation that ends, ended: a screen's rise and its tiles' (`motion.css`).
 *
 * What is measured — contrast, the size of a target — is the page a person
 * reads, not a frame into a fade: a box mid-translate measures 43.9999px tall
 * and a label at half opacity fails a contrast it does not have. The ones
 * that never end (an agent breathing, a shimmer) are not waited for.
 */
const SETTLED = `Promise.all(document.getAnimations()
  .filter((one) => one.effect && one.effect.getTiming().iterations !== Infinity)
  .map((one) => one.finished.catch(() => null)))`

/**
 * What one task screen's control blocks look like.
 *
 * Which verbs have a control, which have a reason instead, which targets are
 * too small to hit, and which blocks are showing a reason that says nothing —
 * the last because a visible empty line under a heading reads as something
 * that failed to load, and there is no offline way to see one.
 *
 * **What `blank` can and cannot see, said rather than assumed.** A reason with
 * nothing in it needs a row that names a verb in neither `can` nor `cannot`,
 * and `ableOn` puts every verb in one of them — so the only way to get one
 * is an older server talking to a newer page, which no fixture here models.
 * It is a guard against that, not a covered behaviour, and reintroducing the
 * drawing bug it is about does **not** turn it red.
 *
 * **Measured once the screen has risen** (`SETTLED`), as `SHAPE` is: the
 * acting pass's phone keeps its motion, and a press caught mid-`rise` sits at
 * a fractional offset and measures 69.906×43.99988 — one run in five, on a
 * button that is 44px tall.
 */
export const CONTROLS = `${SETTLED}.then(() => {
  const TAP = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tap')) || 44
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
  const blank = []
  for (const part of document.querySelectorAll('main .section')) {
    const head = (part.querySelector('h2')?.textContent || '').trim()
    const press = [...part.querySelectorAll('button')].filter((one) => one.offsetParent !== null)
    const why = [...part.querySelectorAll('.empty')].filter(
      (one) => one.offsetParent !== null && (one.textContent || '').trim() !== '',
    )
    if (!(head in NAMED)) continue
    if (press.length > 0) drawn.push(head)
    if (why.length > 0 && press.length === 0) reasons.push(head)
    // A reason that is visible and says nothing, which reads as something that
    // failed to load. The reason's own class and not every paragraph: the
    // status line beside a control is a paragraph too, and is correctly empty
    // until somebody presses something, so a check over both would flag a
    // page that is right.
    for (const one of part.querySelectorAll('p.empty')) {
      if (one.offsetParent !== null && (one.textContent || '').trim() === '') blank.push(head)
    }
    for (const one of press) {
      const box = one.getBoundingClientRect()
      if (box.height < TAP || box.width < TAP) {
        small.push(head + ': ' + Math.round(box.width) + 'x' + Math.round(box.height))
      }
    }
  }
  return {
    drawn: drawn.map((one) => NAMED[one]).filter(Boolean),
    reasons: reasons.map((one) => NAMED[one]).filter(Boolean),
    small,
    blank: [...new Set(blank)],
  }
})`

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
export const SHAPE = `${SETTLED}.then(() => (() => {
  // The page's own floor, --tap: 44px to a thumb, 32px to a mouse at a desk.
  const TAP = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tap')) || 44
  const small = []
  for (const one of document.querySelectorAll('a, button')) {
    const box = one.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) continue
    // A link inside somebody's own words is text, not a target.
    if (one.closest('.said') !== null) continue
    if (box.height < TAP || box.width < 24) {
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
    // The screen scrolls itself rather than the document (\`frame.css\`), so
    // what is wider than the screen is wider than *it*, and the document's
    // figure alone would say nothing ever does.
    within: (() => {
      const main = document.querySelector('main')
      return main === null ? 0 : main.scrollWidth - main.clientWidth
    })(),
    small,
  }
})())`

/**
 * axe, on the page as it stands, and **serious or critical only**.
 *
 * A harness that failed on every `moderate` is one somebody turns off. What is
 * asked here is the half that is not a matter of taste.
 *
 * **After the page has settled**: a screen rises in and its tiles follow
 * (`motion.css`), and contrast measured a frame into a fade is the contrast of
 * text a person never reads at that opacity. So every animation that ends is
 * waited for first; the ones that never do — an agent breathing, a shimmer —
 * are not, and are measured as they are.
 */
export const AXE = `${SETTLED}.then(() => axe.run({ runOnly: { type: 'tag',
  values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).then((answer) =>
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

/**
 * Every place the page cuts text, but the ones `allowed` names (`CUT_ALLOWED`).
 *
 * **Two halves, because either alone misses one.** What is drawn: every
 * visible element with words of its own, asked for an ellipsis, a line clamp,
 * or a single line clipped at its own box — the last because a rule that loses
 * its ellipsis and keeps `nowrap` and `overflow: hidden` cuts as surely, only
 * without saying so. And what could be: every rule in the page's own
 * stylesheets, so a toast, a palette or a dock that is not open on this screen
 * still answers. An allowed fold must be drawn with its mark right after it,
 * or the whole of it is nobody's press away.
 */
export function CUT(allowed: readonly { selector: string; mark: string | null }[]): string {
  return `${SETTLED}.then(() => {
  const ALLOWED = ${JSON.stringify(allowed)}
  const named = (one) => {
    const classes = typeof one.className === 'string' && one.className !== '' ? '.' + one.className.trim().split(/\\s+/).join('.') : ''
    return one.tagName.toLowerCase() + classes + ' "' + one.textContent.trim().slice(0, 40) + '"'
  }
  const ownWords = (one) => [...one.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim() !== '')
  const cut = []
  let folds = 0
  for (const one of document.body.querySelectorAll('*')) {
    if (one.closest('svg, script, style, template, textarea, input, select, .sr-only')) continue
    if (one.textContent.trim() === '' || one.getClientRects().length === 0) continue
    // Words kept for a screen reader alone, \`.sr-only\`'s way under another name: a pixel, clipped.
    const box = one.getBoundingClientRect()
    if (box.width <= 1 && box.height <= 1) continue
    const style = getComputedStyle(one)
    if (style.visibility === 'hidden') continue
    const clamp = style.webkitLineClamp !== '' && style.webkitLineClamp !== 'none'
    const ellipsis = style.textOverflow === 'ellipsis'
    const hides = (value) => value === 'hidden' || value === 'clip'
    const clipped = ownWords(one) && (
      (hides(style.overflowX) && one.scrollWidth > one.clientWidth + 1) ||
      (hides(style.overflowY) && one.scrollHeight > one.clientHeight + 1))
    if (!clamp && !ellipsis && !clipped) continue
    const allow = ALLOWED.find((rule) => one.matches(rule.selector))
    if (allow === undefined) {
      cut.push((clamp ? 'clamped ' : ellipsis ? 'ellipsis ' : 'clipped ') + named(one))
      continue
    }
    if (allow.mark === null) continue
    const mark = one.nextElementSibling
    if (mark === null || !mark.matches(allow.mark) || mark.hidden || mark.getClientRects().length === 0) {
      cut.push('folded with no mark ' + named(one))
    } else folds += 1
  }
  const rules = []
  const walk = (list) => {
    for (const rule of list) {
      if (rule.cssRules) walk(rule.cssRules)
      if (!rule.style) continue
      const clamp = rule.style.getPropertyValue('-webkit-line-clamp') || rule.style.getPropertyValue('line-clamp')
      const asks = rule.style.textOverflow === 'ellipsis' || !['', 'none', 'unset', 'initial'].includes(clamp)
      if (asks && !ALLOWED.some((one) => one.selector === rule.selectorText)) rules.push(rule.selectorText)
    }
  }
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules) } catch { rules.push('a stylesheet that could not be read: ' + sheet.href) }
  }
  return { cut, rules, folds }
})`
}

/**
 * One screen on the foldable Duo, measured as a thumb and an eye meet it
 * (`browser-duo.ts`): what runs off an edge, what is under the phone's own
 * bands, what is too small to hit, and what a tap at a press's middle does not
 * reach because something else is drawn over it.
 *
 * **What is measured is what is seen**: each word's own boxes (a `Range` over
 * its text, so a full-bleed bar whose padding holds the inset is not under it
 * while its words are clear), each press, each drawing — clipped by every
 * region that scrolls or clips it, so a row scrolled below the screen's foot is
 * not under the home indicator, and the screen itself ending above the band is
 * what holds it. Grounds and rules are not content and may reach the edge.
 */
export function DUO_SHAPE(
  insets: { top: number; right: number; bottom: number; left: number },
  room: number | null,
): string {
  return `${SETTLED}.then(() => (() => {
  const I = ${JSON.stringify(insets)}
  const W = innerWidth
  // With the keyboard up the screen is the room above it, not the window.
  const H = ${room === null ? 'innerHeight' : String(room)}
  const TAP = 44
  const named = (one) => one.tagName.toLowerCase() +
    (typeof one.className === 'string' && one.className.trim() !== ''
      ? '.' + one.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') +
    ' "' + (one.getAttribute('aria-label') || one.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 28) + '"'
  const seen = (one) => one.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    one.closest('[inert], [hidden], [aria-hidden="true"]:not(svg)') === null
  // Every region between it and the page that clips it; the body is the screen.
  const clipOf = (one, page) => {
    let box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity }
    for (let up = one.parentElement; up !== null; up = up.parentElement) {
      if (up === document.body || up === document.documentElement) break
      const style = getComputedStyle(up)
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
      const r = up.getBoundingClientRect()
      box = { l: Math.max(box.l, r.left), t: Math.max(box.t, r.top), r: Math.min(box.r, r.right), b: Math.min(box.b, r.bottom) }
    }
    if (page) box = { l: Math.max(box.l, 0), t: Math.max(box.t, 0), r: Math.min(box.r, W), b: Math.min(box.b, H) }
    return box
  }
  const within = (r, box) => {
    const out = { l: Math.max(r.left, box.l), t: Math.max(r.top, box.t), r: Math.min(r.right, box.r), b: Math.min(r.bottom, box.b) }
    return out.r - out.l > 0.5 && out.b - out.t > 0.5 ? out : null
  }
  const bands = (box) => [
    box.t < I.top - 0.5 ? 'the status bar' : '',
    box.b > H - I.bottom + 0.5 ? 'the home indicator' : '',
    box.l < I.left - 0.5 ? 'the camera column' : '',
    box.r > W - I.right + 0.5 ? 'the right edge band' : '',
  ].filter((one) => one !== '')
  const off = []
  const under = []
  const small = []
  const covered = []
  const squeezed = []
  const note = (list, line) => { if (!list.includes(line) && list.length < 12) list.push(line) }
  const look = (owner, rects) => {
    const page = clipOf(owner, true)
    const free = clipOf(owner, false)
    for (const r of rects) {
      if (r.width < 0.5 || r.height < 0.5) continue
      const unclipped = within(r, free)
      if (unclipped !== null && (unclipped.l < -1 || unclipped.r > W + 1)) {
        note(off, named(owner) + ' reaches ' + Math.round(unclipped.l) + '…' + Math.round(unclipped.r))
      }
      const shown = within(r, page)
      if (shown === null) continue
      for (const band of bands(shown)) note(under, named(owner) + ' under ' + band)
    }
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
    if (text.nodeValue.trim() === '') continue
    const owner = text.parentElement
    if (owner === null || owner.closest('svg.sprite, script, style') !== null || !seen(owner)) continue
    const range = document.createRange()
    range.selectNodeContents(text)
    const boxes = range.getClientRects()
    look(owner, boxes)
    // A word given no room breaks a letter or two to a line: four lines and
    // more, none of them wider than two letters, is a column too narrow to read.
    const word = text.nodeValue.trim()
    if (word.length >= 4 && boxes.length >= 4 && [...boxes].every((one) => one.width <= 20)) {
      note(squeezed, named(owner))
    }
  }
  const PRESSES = 'a[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="tab"], [role="option"]'
  for (const one of document.querySelectorAll(PRESSES + ', main svg, header svg, nav svg, img, canvas')) {
    if (!seen(one) || one.closest('svg.sprite') !== null) continue
    look(one, [one.getBoundingClientRect()])
  }
  // A drawer or a sheet open over its scrim is the one layer a tap reaches;
  // what is under it is meant to be.
  const scrim = document.querySelector('.scrim')
  const layer = scrim !== null && !scrim.hidden
    ? document.querySelector('.side-open .side, .tade-open .dock')
    : null
  for (const one of document.querySelectorAll(PRESSES)) {
    if (!seen(one)) continue
    const r = one.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    // A link inside somebody's own words is text, not a target.
    if (one.closest('.said') !== null) continue
    if (r.height < TAP - 0.5 || r.width < TAP - 0.5) {
      note(small, named(one) + ' ' + Math.round(r.width * 10) / 10 + '×' + Math.round(r.height * 10) / 10)
    }
    const shown = within(r, clipOf(one, true))
    if (shown === null || (layer !== null && !layer.contains(one))) continue
    const x = (shown.l + shown.r) / 2
    const y = (shown.t + shown.b) / 2
    const hit = document.elementFromPoint(x, y)
    if (hit === null || hit === one || one.contains(hit) || hit.contains(one)) continue
    if (hit.closest('label') !== null && hit.closest('label').contains(one)) continue
    note(covered, named(one) + ' under ' + named(hit))
  }
  const main = document.querySelector('main')
  const sideways = Math.max(
    (document.scrollingElement ? document.scrollingElement.scrollWidth : 0) - W,
    main === null ? 0 : main.scrollWidth - main.clientWidth,
  )
  // The field being typed in and the header, both wholly in the room.
  const whole = (one) => {
    if (one === null) return false
    const r = one.getBoundingClientRect()
    return r.height > 0 && r.top >= -0.5 && r.bottom <= H + 0.5
  }
  const typing = document.activeElement instanceof HTMLTextAreaElement
    ? { field: whole(document.activeElement), head: whole(document.querySelector('header.top')) }
    : null
  return { sideways, off, under, small, covered, squeezed, typing }
})())`
}
