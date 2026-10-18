// The conversation with Tade, and the one box on this page that sends words.
//
// **Its own file**, because it is the one screen that is not a list of rows
// about work: it is an exchange, read from the bottom, with a composer under
// it, and the strip on a desk is drawn from the same module (`composerOf`), so
// it is shared rather than a page of its own.
//
// The five rules that break this screen quietly:
//
// - **A reply is drawn as markdown and never as markup.** `conversation.js`
//   reads it with `markdown.js`, which builds the page's own nodes out of a
//   closed list and puts every character in a text node: there is no
//   `innerHTML` anywhere, and that is what actually stands against a reply
//   quoting an injected `<script>` out of something an agent read. A person's
//   own words are drawn as they typed them.
// - **What was typed survives everything but a `200`.** A `409` is the world
//   having moved — Tade started answering somebody else — and throwing away
//   the paragraph somebody typed on a phone because of it is the one failure
//   they cannot undo. Three different things could take it: a delta, which
//   cannot, because the screen is built once and patched (`keyed`); a
//   navigation, which replaces the region and so is answered by `draftStore`;
//   and a refusal, which is `afterAnswer`'s one line.
// - **The composer is absent where it could not be used**, with its reason.
//   Three different absences and three different sentences: this surface is
//   not turned on, this device was not granted it, or Tade is answering
//   somebody else. A disabled box invites a paragraph and then refuses it.
// - **Tade's own words, never this page's.** What came of a press is the
//   answer's `said`; what the conversation says is the projection's. There is
//   no sentence here about what Tade is doing.
// - **The line that says who asked is not decoration.** A request from a
//   paired device that read as something the person typed would be the `said`
//   confusion in the one place somebody actually reads the words.

import { mayFor } from './access.js'
import { afterAnswer, askBody, stopBody } from './acts.js'
import { keyOf } from './controls.js'
import { CALL_STATES, callIn, callRow, wordsIn } from './conversation.js'
import { classOn, el, empty, hintOf, into, keyed, textIn, toneOn } from './dom.js'
import { ageSaid } from './figures.js'
import { followOf } from './follow.js'
import { CHAT_KINDS, toolNamed } from './glyphs.js'
import { icon } from './icons.js'
import { plainOf } from './markdown.js'
import { nothingSaid, section } from './rows.js'
import { chatOf, omitted, talkOf } from './store.js'
import { answerIn } from './ui.js'

/** How long a message may be, which is `ASK_BOUND` said on this side. */
const BOUND = 4000

/**
 * What somebody has typed and not sent, kept across a navigation.
 *
 * **A navigation is the one moment the page replaces a region** — that is the
 * rule, and it is right: it is what the person asked for, and focus moving to
 * the new screen is correct. What is wrong is losing a half-typed message to
 * it: tapping Now to check what an agent is doing and coming back to an empty
 * box is the same failure as a refusal clearing it, and the person cannot undo
 * either.
 *
 * **In this module and nowhere on the device.** It is this tab's half-finished
 * sentence: worth keeping while the page is open, and not worth writing into
 * the browser's own storage — which this page may never touch at all, and
 * which `test/assets.test.ts` holds it to by name. Exported so that what
 * survives a rebuild is a thing a test can hold rather than a listener nothing
 * offline can reach.
 */
export function draftStore() {
  let held = ''
  return {
    get: () => held,
    set: (said) => {
      held = typeof said === 'string' ? said : ''
    },
  }
}

/** The one draft this page keeps, which is why it is made once and not per screen. */
const draft = draftStore()

export function talkScreen(ctx) {
  const node = el('div')
  const made = section('TADE', { top: true })
  // **What is older than this page is said once, at the top of the
  // conversation**, where somebody scrolling up to it is looking for it — never
  // as a line over the box, which every exchange would have to read past.
  const older = el('p', { class: 'chat-earlier' })
  const list = el('ul', { class: 'rows chat' })
  const none = empty('nothing said yet')
  into(made.body, older, list, none)

  const composer = section('SAY SOMETHING')
  // Held at the foot of the screen as a chat's box is, over the tab bar on a
  // phone, so the newest line and the box are on screen together.
  composer.node.classList.add('composer-dock')
  const typing = composerOf(ctx, {
    label: 'what to say to Tade',
    placeholder: 'Ask Tade…',
    send: 'Send',
    rows: '1',
  })
  // **Read as a chat**: opened at the newest line, kept there while it is
  // followed, let go the moment somebody scrolls up — and one press, over the
  // box, to come back down. The region is the frame's `main`, which this
  // screen is put into only after it is built.
  const follow = followOf(() => node.closest?.('main') ?? null)
  into(composer.body, ...typing.nodes)
  composer.node.prepend(follow.press)
  into(node, made.node, composer.node)

  return {
    node,
    /** Left: `main` is the frame's and stays, so what listens to it goes. */
    leave: () => follow.leave(),
    update(view) {
      const lines = chatOf(view.store)
      textIn(made.figure, lines.length === 0 ? '' : String(lines.length))
      none.hidden = lines.length > 0
      textIn(
        none,
        nothingSaid(mayFor(view.store, 'chat'), omitted(view.store, 'chat'), 'nothing said yet'),
      )
      keyed(
        list,
        lines,
        (line) => line.id,
        createChatLine,
        (one, line) => fillChatLine(one, line, view),
      )
      const left = omitted(view.store, 'chat')
      const more = left > 0 && mayFor(view.store, 'chat') && lines.length > 0
      textIn(older, more ? `↑ ${left} earlier, in the window` : '')
      older.hidden = !more
      typing.update(talkOf(view.store), view)
      if (lines.length > 0) follow.drawn()
    },
  }
}

/**
 * A box, a press to send it and a press to stop the turn — **the one way this
 * page says anything to Tade**, used by this screen and by the strip at the
 * foot of a desk (`desk.js`).
 *
 * One function for both, so there is one draft, one `afterAnswer` and one
 * three-sentence absence rather than a second copy of each that drifts: the
 * strip is a smaller box over the same ask flow, not a second door. Nothing
 * here can reach an agent — a message goes to Tade, which is narrowed to what
 * this device was granted at the machine (`origin.ts`) and written down under
 * its id.
 */
export function composerOf(ctx, words) {
  // **The absence in a word, and its sentence one tap away** (`hintOf`): what
  // to do about a box that is not here is a sentence somebody may need once,
  // and a paragraph under every screen's strip for everybody else.
  const why = el('div', { class: 'why-short' })
  const whyWord = el('p', { class: 'empty' })
  const whyMore = hintOf('')
  into(why, whyWord, whyMore.press, whyMore.body)
  const box = el('textarea', {
    attrs: {
      rows: words.rows,
      maxlength: String(BOUND),
      placeholder: words.placeholder,
      'aria-label': words.label,
    },
  })
  box.value = draft.get()
  // The box grows with what is typed, up to a few lines, and then scrolls:
  // a one-line box a paragraph is typed into hides the paragraph.
  const grow = () => {
    box.style.setProperty('height', 'auto')
    box.style.setProperty('height', `${Math.min(box.scrollHeight, 200)}px`)
  }
  box.addEventListener('input', () => {
    draft.set(box.value)
    grow()
    settle()
  })
  // **Enter sends at a keyboard, and never on a phone**, where Enter is the
  // only way to start a new line. Shift+Enter is a new line everywhere.
  box.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    if (globalThis.matchMedia?.('(pointer: fine)').matches !== true) return
    event.preventDefault()
    press.click()
  })
  // **While Tade answers, the box's place says what it is doing** — a spinner
  // in the window's own style (it turns one while the orchestrator thinks),
  // the call in flight in words, and how long it has been at it — with Stop
  // in the field where Send was, rather than a line and a press on their own.
  const live = el('div', { class: 'ask-live', attrs: { role: 'status' } })
  const spin = el('span', { class: 'ask-spin', attrs: { 'aria-hidden': 'true' } })
  const doing = el('span', { class: 'ask-doing' })
  const took = el('span', { class: 'ask-took' })
  into(live, spin, doing, took)
  live.hidden = true
  const press = el('button', {
    class: 'press ask-send',
    attrs: { type: 'button', 'aria-label': words.send },
  })
  into(press, icon('send'), el('span', { text: words.send }))
  const stop = el('button', {
    class: 'press ask-stop',
    attrs: { type: 'button', 'aria-label': 'Stop what Tade is doing' },
  })
  into(stop, icon('stop'), el('span', { text: 'Stop' }))
  const field = el('div', { class: 'ask-field' })
  into(field, box, live, press, stop)
  const said = el('p', { attrs: { role: 'status' } })

  let talk = null
  /** What `talkOf` said, `undefined` included: nothing read yet is not *off*. */
  let told
  let going = false
  /** What the last paint said Tade is doing, and the moment that paint was drawn against. */
  let seen = { lines: [], asOf: 0, frozen: true, at: 0 }
  let ticking = null

  /** One press, and the answer is the only thing that clears the box. */
  const send = async (what, body) => {
    if (going || talk === null) return
    going = true
    settle()
    const answer = await ctx.ask('POST', `/api/ask/${what}`, body)
    going = false
    const came = afterAnswer(answer, ctx.sentence(answer))
    answerIn(said, came.said, came.trouble)
    if (came.clear && what === 'ask') {
      box.value = ''
      draft.set('')
      grow()
    }
    settle()
  }

  /** How long the turn has been going, against the server's clock moved on by this one's. */
  const tookIn = () => {
    const since = talk?.since ?? null
    const now = seen.frozen ? seen.asOf : seen.asOf + (Date.now() - seen.at)
    const age = since === null ? null : ageSaid(since, now, false)
    textIn(took, age === null ? '' : age)
    took.hidden = age === null
  }

  /**
   * What the two controls and the box are, given what is true now.
   *
   * One function for all three, so a screen cannot turn the box on and leave
   * the reason beside it from the last frame.
   */
  const settle = () => {
    const mine = talk !== null && talk.mine === true
    const busy = talk !== null && talk.busy === true
    field.hidden = !mine
    box.hidden = busy
    live.hidden = !busy
    press.hidden = busy
    stop.hidden = !busy
    press.disabled = going
    stop.disabled = going
    // Nothing typed is a quieter Send, never a disabled one: pressing it does
    // nothing, and a press that cannot be pressed is one nobody can explain.
    classOn(field, 'is-empty', box.value.trim() === '')
    classOn(field, 'is-busy', busy)
    classOn(field, 'is-going', going)
    if (busy) {
      textIn(doing, doingOf(seen.lines, talk))
      tookIn()
    }
    // A second hand only while something is being waited on, and only while
    // the page is live: a frozen page's ages stop, and so does this one.
    const tick = busy && !seen.frozen
    if (tick && ticking === null) ticking = setInterval(tookIn, 1000)
    if (!tick && ticking !== null) {
      clearInterval(ticking)
      ticking = null
    }
    const reason = mine ? '' : reasonFor(told)
    textIn(whyWord, mine ? '' : reasonWord(told))
    textIn(whyMore.body, reason)
    why.hidden = reason === ''
  }

  press.addEventListener('click', () => {
    if (talk === null || box.value.trim() === '') return
    void send('ask', askBody(talk, keyOf(), ctx.revOf(), box.value))
  })
  stop.addEventListener('click', () => {
    if (talk === null) return
    void send('stop', stopBody(talk, keyOf(), ctx.revOf()))
  })

  return {
    nodes: [why, field, said],
    update(next, view) {
      told = next
      talk = next ?? null
      if (view !== undefined) {
        seen = {
          lines: chatOf(view.store),
          asOf: view.asOf,
          frozen: view.frozen === true,
          at: Date.now(),
        }
      }
      // **The draft is the page's and the box is this one's view of it**: the
      // other composer may have been typed into since this one last drew, and
      // a box somebody is typing in is never written under them.
      if (document.activeElement !== box && box.value !== draft.get()) box.value = draft.get()
      settle()
    },
  }
}

/**
 * What Tade is doing now, in a few words: the call in flight — *Reading
 * NAMES.md*, *Creating a task* — or its answer being written, or thinking.
 *
 * Out of the conversation's own last lines, so it is what the strip shows and
 * nothing the page guessed: a tool line still going is the call in flight, and
 * its `brief` (the arguments the window draws beside it) says which.
 */
export function doingOf(lines, talk = null) {
  const last = lines.at(-1)
  const whose = talk?.whose === 'you' ? ' for you, at the machine' : ''
  if (last?.kind === 'tool' && last.outcome === 'running') {
    return `${callDoing(last.tool, last.call?.brief ?? null)}…${whose}`
  }
  if (last?.kind === 'reply' && last.streaming === true) return `Writing its answer…${whose}`
  return `Thinking…${whose}`
}

/**
 * A call in flight as what it is doing: a verb for the kinds of tool every
 * harness has, and Tade's own in its own words. Where nothing is known of it,
 * its name: *Using deps check*.
 */
export function callDoing(tool, brief) {
  const name = toolNamed(tool)
  const first = firstOf(brief)
  for (const [shape, verb, object] of DOING) {
    if (!shape.test(name)) continue
    const what = object === 'file' ? lastName(first) : object === 'whole' ? first : ''
    return what === '' ? verb : `${verb} ${what}`
  }
  return `Using ${name}`
}

/** The verbs, by the name a tool reads as: what it does, and how much of its brief to name. */
const DOING = [
  [/^(read|view|cat|open)\b/i, 'Reading', 'file'],
  [/^(write|create file)\b/i, 'Writing', 'file'],
  [/^(edit|multi ?edit|apply ?patch|str replace)/i, 'Editing', 'file'],
  [/^(bash|shell|exec|run|command|terminal run)\b/i, 'Running', 'whole'],
  [/^(grep|glob|search|find|ls|list)\b/i, 'Searching', 'whole'],
  [/^web ?fetch|^fetch\b/i, 'Fetching', 'whole'],
  [/^web ?search/i, 'Searching the web for', 'whole'],
  [/^task create\b|^run start\b|^start\b/i, 'Creating a task', ''],
  [/^steer\b/i, 'Steering', 'whole'],
  [/^plan\b/i, 'Planning', ''],
  [/^proposal decide\b/i, 'Deciding a proposal', ''],
  [/^(status|logs|summary|spend)\b/i, 'Looking at the work', ''],
  [/^(note|memory remember|remember)\b/i, 'Writing a note', ''],
  [/^(approve|deny)\b/i, 'Answering an approval', ''],
  [/^(checks run|check)\b/i, 'Running the checks', ''],
  [/^agent\b|^task\b/i, 'Starting an agent', ''],
]

/** The first of a brief's parts, its quotes off and cut to a few words. */
function firstOf(brief) {
  if (typeof brief !== 'string' || brief === '') return ''
  const first = (brief.split(' · ')[0] ?? '').replace(/^"|"$/g, '').trim()
  return first.length > 40 ? `${first.slice(0, 39)}…` : first
}

/** A path's last name: `~/.tade/…/NAMES.md` is `NAMES.md`. */
function lastName(path) {
  const parts = path.split('/').filter((one) => one !== '')
  return parts.at(-1) ?? ''
}

/** The same three absences in a word or two, for where the sentence is behind a `?`. */
export function reasonWord(talk) {
  if (talk === undefined) return ''
  if (talk === null) return 'Talking is off'
  if (talk.mine !== true) return 'Not granted'
  if (talk.busy === true) return 'Answering'
  return ''
}

/**
 * Why there is no box, in words — or empty where there is one.
 *
 * **Three absences and three sentences**, because the thing to do about each is
 * different: turn a setting on at the machine, be granted it at the machine, or
 * wait. A page that said *you cannot do that* to all three would send somebody
 * to the wrong place twice out of three times.
 */
export function reasonFor(talk) {
  // Nothing read yet: the freshness line says why, and there is no setting to name.
  if (talk === undefined) return ''
  if (talk === null) {
    return 'Talking to Tade is not turned on for this machine. It is a setting in the window, beside the one that let this device in.'
  }
  if (talk.mine !== true) {
    return 'This device was not granted talking to Tade. That needs the person at the machine: it is a control in the away panel, beside the one that lets a device act.'
  }
  if (talk.busy === true) {
    return talk.whose === 'you'
      ? 'Tade is answering the person at the machine.'
      : `Tade is answering ${talk.whose ?? 'something'}.`
  }
  return ''
}

/**
 * An empty line of the conversation, **the one drawing of a line on this
 * page**: the screen's whole conversation and the dock's last lines are both
 * made of these, so collapsed and open read alike.
 *
 * A mark down the left — the window's own, in its colour — and the line beside
 * it: who and when where that is worth saying, the words, and for a tool one
 * row that opens onto the call.
 */
export function createChatLine() {
  const node = el('li', { class: 'line' })
  const mark = el('span', { class: 'line-mark' })
  into(mark, el('span', { attrs: { 'aria-hidden': 'true' } }), el('span', { class: 'sr-only' }))
  const body = el('div', { class: 'line-body' })
  into(
    body,
    el('p', { class: 'aside' }),
    el('div'),
    el('p', { class: 'unknown', text: 'more than this was written down' }),
    callRow(),
  )
  into(node, mark, body)
  return node
}

/**
 * The mark a line is drawn with: its kind's (`CHAT_KINDS`), or for a tool how
 * the call went (`CALL_STATES`) — `✓` green, `✗` red, a spinner while it runs.
 */
export function lineMark(line) {
  if (line.kind === 'tool') return CALL_STATES[line.outcome] ?? CALL_STATES.none
  return CHAT_KINDS[line.kind] ?? CHAT_KINDS.tade
}

/**
 * One line: its mark, and the words — or, for a tool, one row that opens.
 *
 * The words are written **every** time rather than once, which is the one
 * difference from a note: a reply arrives in pieces, so the row it is in is
 * patched as it streams, and `markdownIn` draws again only the part of it
 * being written. Everything else about the row is stable.
 */
export function fillChatLine(node, line, view) {
  const [mark, body] = node.children
  const [glyph, word] = mark.children
  const [head, words, cut, call] = body.children
  const kind = CHAT_KINDS[line.kind] ?? CHAT_KINDS.tade
  const tool = line.kind === 'tool'
  const drawn = lineMark(line)
  textIn(glyph, drawn.glyph)
  // A tool's row says how it went in its own words; every other line's mark
  // is said as its kind, so a screen reader hears who is speaking.
  textIn(word, tool ? '' : ` ${kind.word}`)
  toneOn(mark, drawn.tone)
  classOn(mark, 'is-spinning', tool && line.outcome === 'running')
  // Who and when, over what somebody asked — the start of an exchange, and
  // the one place a request from a device must not read as the person's own.
  // Tade's lines say who they are by their mark, as the window's do.
  const age = ageSaid(line.at, view.asOf, view.frozen)
  const asked = line.kind === 'asked'
  textIn(
    head,
    asked
      ? [whoSaid(line), age]
          .filter((one) => one !== '' && one !== null && one !== undefined)
          .join(' · ')
      : '',
  )
  head.hidden = !asked
  call.hidden = !tool
  if (tool) {
    callIn(call, { tool: line.tool, outcome: line.outcome ?? 'none', call: line.call ?? null })
    words.hidden = true
  } else {
    wordsIn(words, line.text, marked(line))
  }
  // What the budget cut is said, never drawn as three dots in somebody's words.
  cut.hidden = tool || line.text?.more !== true
  for (const one of ['asked', 'reply', 'tool', 'tade', 'problem']) {
    classOn(node, `is-${one}`, line.kind === one)
  }
  classOn(node, 'is-failed', tool && line.outcome === 'failed')
  classOn(node, 'is-streaming', line.streaming === true)
}

/** The model's words and Tade's are markdown; a person's are as they typed them. */
function marked(line) {
  return line.kind === 'reply' || line.kind === 'tade'
}

/**
 * Who said it, in the words the record uses.
 *
 * `you` is the person at the machine and a device is its id — the same id the
 * journal writes and the device list shows, so a line on a phone joins up with
 * both. Empty for Tade's own lines and the model's, where the kind's own word
 * already says it.
 */
export function whoSaid(line) {
  if (line.from === null || line.from === undefined || line.from === '') return ''
  return line.from === 'you' ? 'you, at the machine' : line.from
}

/**
 * The words on a line, or Tade's own clause where there are none.
 *
 * A tool line has no words by construction: what crossed is the name and the
 * outcome, because its arguments are the call itself. So the clause says what
 * happened rather than leaving the row blank, which would read as a reply that
 * failed to load.
 */
export function saidOn(line) {
  if (line.text !== null && line.text !== undefined) {
    // On one line the marks are taken off rather than drawn: `**` and `#` in
    // a preview are noise, and a heading or a list has no room to be one.
    const words = marked(line) ? plainOf(line.text.words) : line.text.words
    return words + (line.text.more === true ? ' …' : '')
  }
  if (line.kind === 'tool') {
    return line.outcome === 'running' ? 'still going' : ''
  }
  return ''
}
