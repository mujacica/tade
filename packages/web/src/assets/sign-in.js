// The orchestrator's sign-in, carried out from the person's own phone:
// `/login` typed on the line opens this sheet rather than going to Tade.
//
// **The harness's own sign-in runs on the machine** (`signing-in.ts`, and the
// window's `web-sign-in.ts`), the way it runs for a machine nobody is at: it
// prints a link, and takes back what that page gives. The sheet is the hands
// on it — the link as a press, its screen as it stands, a field for the code
// and the keys a sign-in's own menu is moved with — and every press is one
// `POST` answered with where it stands. Closing the sheet leaves it running:
// the link opens in another tab, and `/login` again comes back to it.
//
// **Its screen is text and only text**, as an agent's is (`agent-pane.js`):
// one text node, cleaned at the machine first. The link is the one href, and
// only ever `https`.

import { afterAnswer } from './acts.js'
import { el, into, textIn } from './dom.js'
import { icon } from './icons.js'
import { answerIn } from './ui.js'

export const SIGN_IN_PATH = '/api/orchestrator/sign-in'

/** How often an open sheet asks again while the sign-in runs. */
export const EVERY_MS = 1_000

/** The keys a sign-in's own menu is moved with: what each sends, its face and its name. */
export const SIGN_IN_KEYS = [
  ['up', '↑', 'Up'],
  ['down', '↓', 'Down'],
  ['enter', 'Enter', 'Enter'],
  ['escape', 'Esc', 'Escape'],
  ['tab', 'Tab', 'Tab'],
]

/** Whether a line is `/login`, as the window reads its commands: the first word, any case. */
export function isLogin(said) {
  return /^\/login(?:\s|$)/i.test(String(said ?? '').trim())
}

/** The words above the screen: who it signs in, then the harness's own, or how it ended. */
export function signInSaid(standing) {
  if (standing === null) return 'Starting the orchestrator’s sign-in…'
  if (standing.state === 'ended') return standing.said ?? 'The sign-in ended.'
  const who = standing.who === null ? '' : `The orchestrator runs as ${standing.who}. `
  return `${who}${standing.how ?? ''}`.trim()
}

/** The link to sign in on, where it is one a page may open: `https` alone. */
export function linkOf(standing) {
  const link = standing?.link
  return typeof link === 'string' && /^https:\/\//.test(link) ? link : null
}

/**
 * The sheet, built once. `open(from)` starts the sign-in, or comes back to the
 * one running; `later` and `cancel` are the clock, a test's own where given.
 */
export function signInSheet(ctx, later = setTimeout, unlater = clearTimeout) {
  const node = el('div', {
    class: 'amenu signin',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'signin-head' },
  })
  node.hidden = true
  const scrim = el('div', { class: 'scrim', attrs: { 'aria-hidden': 'true' } })
  const box = el('div', { class: 'amenu-box signin-box' })
  const top = el('div', { class: 'amenu-top' })
  const head = el('h2', {
    class: 'amenu-head',
    text: 'Sign the orchestrator in',
    attrs: { id: 'signin-head' },
  })
  const close = el('button', {
    class: 'tap icon',
    attrs: { type: 'button', 'aria-label': 'Close' },
  })
  into(close, icon('close'))
  into(top, head, close)
  const body = el('div', { class: 'signin-body' })
  const how = el('p', { class: 'signin-how', attrs: { role: 'status' } })
  const link = el('a', {
    class: 'press signin-link',
    text: 'Open the sign-in page',
    attrs: { target: '_blank', rel: 'noopener noreferrer' },
  })
  const screen = el('pre', {
    class: 'signin-screen',
    attrs: { tabindex: '0', 'aria-label': 'What the sign-in shows' },
  })
  const form = el('form', { class: 'amenu-form signin-form' })
  const input = el('input', {
    attrs: {
      type: 'text',
      maxlength: '4096',
      'aria-label': 'The code the sign-in page gives you',
      placeholder: 'Paste the code here',
      autocomplete: 'one-time-code',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      enterkeyhint: 'send',
    },
  })
  const send = el('button', { class: 'press', text: 'Send', attrs: { type: 'submit' } })
  into(form, input, send)
  const keys = el('div', { class: 'signin-keys', attrs: { role: 'group', 'aria-label': 'Keys' } })
  for (const [key, face, name] of SIGN_IN_KEYS) {
    const press = el('button', {
      class: 'tap signin-key',
      text: face,
      attrs: { type: 'button', 'aria-label': name },
    })
    press.addEventListener('click', () => void post({ do: 'key', key }))
    into(keys, press)
  }
  const end = el('button', {
    class: 'press signin-end',
    text: 'Cancel the sign-in',
    attrs: { type: 'button' },
  })
  const said = el('p', { class: 'amenu-said', attrs: { role: 'status' } })
  into(body, how, link, screen, form, keys, end)
  into(box, top, body, said)
  into(node, scrim, box)

  let standing = null
  let opener = null
  let timer = null
  let mounted = false

  const paint = () => {
    const running = standing?.state === 'running'
    textIn(how, signInSaid(standing))
    const href = linkOf(standing)
    link.hidden = href === null || !running
    if (href !== null) link.setAttribute('href', href)
    const rows = Array.isArray(standing?.rows) ? standing.rows : []
    textIn(screen, rows.join('\n'))
    screen.hidden = rows.length === 0
    form.hidden = !running
    keys.hidden = !running
    end.hidden = !running
  }

  const again = () => {
    unlater(timer)
    timer = null
    if (node.hidden || standing?.state !== 'running') return
    timer = later(() => void post({ do: 'look' }), EVERY_MS)
  }

  async function post(call) {
    const answer = await ctx.ask('POST', SIGN_IN_PATH, call)
    if (answer.status === 200 && typeof answer.body?.state === 'string') {
      standing = answer.body
      textIn(said, '')
    } else {
      const came = afterAnswer(answer, ctx.sentence(answer))
      answerIn(said, came.said, came.trouble)
    }
    paint()
    again()
    return answer
  }

  const shut = () => {
    if (node.hidden) return
    node.hidden = true
    unlater(timer)
    timer = null
    document.documentElement.classList.remove('pal-open')
    if (opener !== null && typeof opener.focus === 'function') opener.focus()
    opener = null
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (text === '') return
    input.value = ''
    void post({ do: 'type', text })
  })
  end.addEventListener('click', () => void post({ do: 'cancel' }))
  close.addEventListener('click', shut)
  scrim.addEventListener('click', shut)
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    shut()
  })

  return {
    node,
    /** Open it: the sign-in started, or the one running come back to. */
    open(from) {
      if (!mounted) {
        document.body.append(node)
        mounted = true
      }
      opener = from ?? null
      standing = null
      textIn(said, '')
      node.hidden = false
      document.documentElement.classList.add('pal-open')
      paint()
      close.focus()
      return post({ do: 'start' })
    },
    close: shut,
  }
}
