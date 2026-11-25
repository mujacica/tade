// Accounts: who each harness's agents run as, on every one of the person's
// machines — the window's Settings › Accounts, on the phone, with its tabs.
//
// **A tab per machine**, this one first and then every one it links to: a
// phone paired with one machine reaches the others through it
// (`POST /api/accounts` names the machine, and this machine asks it over its
// link as its owner). One machine is no tabs.
//
// **What somebody opening this wants** is whether each sign-in is working and
// how much of its plan is left, so each account leads with that: who it is
// signed in as, the plan, each window's share used, who runs as it. Then its
// presses, the window's own: sign it in, sign it out, have new agents use it,
// name it, set its key, take it away — and, under a harness that keeps
// accounts apart, add one. Removing is asked twice, as at the machine.
//
// **Signing in is the harness's own, on the machine whose account it is**
// (`sign-in.js`'s sheet, `POST /api/accounts/sign-in`): it prints a link to
// open here and takes back the code that page gives. The token goes where the
// harness keeps it there, never through Tade, and the page asks again once the
// sign-in is over.
//
// **Asked when the screen opens, on a tab, and on Read again — never on the
// stream**, the way Settings is: accounts change when somebody changes one, and
// every press answers with the page as it stands after it.
//
// Every word is `accounts-shape.js`'s or the machine's.

import { el, into, keyed, skeleton, textIn } from '../dom.js'
import { icon } from '../icons.js'
import { section } from '../rows.js'
import { signInSheet } from '../sign-in.js'
import { fullAccessOf, theirsTrouble, UNKNOWN_TROUBLE } from '../trouble.js'
import { answerIn, panel, stateBox, stateBoxIn } from '../ui.js'
import {
  ACCOUNT_SIGN_IN_PATH,
  ACCOUNTS_PATH,
  accountKey,
  accountName,
  accountSignInSaid,
  addsOf,
  askedOf,
  emptySaid,
  harnessesOf,
  lookBody,
  pressBody,
  pressesOf,
  signInHeading,
  signInWith,
  statusSaid,
  tabHere,
  tabSaid,
  tabsOf,
  whoseSaid,
  windowsSaid,
} from './accounts-shape.js'

/** What a refusal is, as `stateBoxIn` draws it. */
function boxOf(kind, title, line = null, action = null, steps = null) {
  return { kind, title, line, action, steps }
}

/** A press the machine answered but did not carry out, as `answerIn` draws trouble. */
function notDone(fix) {
  const title = 'That did not happen'
  return { title, fix }
}

/** Whether an answer is one the page can draw. */
function drawable(body) {
  return Array.isArray(body?.machines) && (body.accounts === null || Array.isArray(body.accounts))
}

/**
 * A button whose press is whatever it was last drawn to do: one listener for
 * its life, so a row drawn again is never a second listener on one button.
 */
function pressable(klass) {
  const press = el('button', { class: klass, attrs: { type: 'button' } })
  press.addEventListener('click', () => RUNS.get(press)?.())
  return press
}

/** What each drawn button does now. */
const RUNS = new WeakMap()

export function accountsScreen(ctx) {
  const node = el('div')
  const top = section('ACCOUNTS', { top: true })
  const again = el('button', { class: 'press quietly small ac-again', attrs: { type: 'button' } })
  into(again, icon('refresh'), el('span', { text: 'Read again' }))
  into(top.tools, again)

  const coming = skeleton(5)
  const failed = stateBox()
  const tabs = el('div', { class: 'ac-tabs', attrs: { role: 'group', 'aria-label': 'Machine' } })
  const said = el('p', { class: 'ac-said', attrs: { role: 'status' } })
  const nothing = stateBox()
  const groups = el('div', { class: 'ac-groups' })
  // That an agent runs as you whichever sign-in it is on, said where you choose one.
  const keys = el('p', { class: 'ac-keys' })
  const body = el('div', { class: 'ac-body' })
  into(body, tabs, said, nothing, groups, keys)
  into(top.body, coming, failed, body)
  into(node, top.node)

  // The one field a press that needs words asks with, moved to where it was pressed.
  const ask = el('form', { class: 'ac-ask' })
  const askLabel = el('label', { class: 'ac-ask-label' })
  const field = el('input', {
    attrs: {
      type: 'text',
      maxlength: '4096',
      autocomplete: 'off',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      enterkeyhint: 'done',
    },
  })
  const askPresses = el('div', { class: 'presses' })
  const save = el('button', { class: 'press small', text: 'Save', attrs: { type: 'submit' } })
  const cancel = el('button', {
    class: 'press quietly small',
    text: 'Cancel',
    attrs: { type: 'button' },
  })
  into(askPresses, save, cancel)
  into(askLabel, el('span', { class: 'ac-ask-word' }), field)
  into(ask, askLabel, askPresses)

  let answer = null
  let refused = null
  /** The machine's tab chosen: null for this one. */
  let chosen = null
  let asking = false
  let busy = false
  let gone = false
  /** A press asked once that wants a second: Remove. */
  let armed = null
  /** A press waiting for its words: the press, whose it is, and its harness's group. */
  let wanting = null
  /** What the last press came to, where it did not come back as the page. */
  let trouble = null
  let sheet = null

  const signing = () => {
    sheet ??= signInSheet(ctx, setTimeout, clearTimeout, {
      path: ACCOUNT_SIGN_IN_PATH,
      heading: 'Sign an account in',
      said: accountSignInSaid,
      id: 'ac-signin-head',
    })
    return sheet
  }

  /** Each harness's section, by its node: its heading, its list, its adds and the line why not. */
  const parts = new WeakMap()

  function createGroup() {
    const made = section('')
    const list = panel('ul', 'ac-list')
    const adds = el('div', { class: 'presses ac-adds' })
    const slot = el('div', { class: 'ac-slot' })
    const why = el('p', { class: 'ac-why' })
    into(made.body, list, adds, slot, why)
    parts.set(made.node, { heading: made.heading, list, adds, slot, why })
    return made.node
  }

  function fillGroup(part, group) {
    const made = parts.get(part)
    textIn(made.heading, group.head.toUpperCase())
    made.heading.setAttribute('aria-label', group.head)
    const many = group.accounts.length > 1
    keyed(made.list, group.accounts, accountKey, createAccount, (item, one) =>
      fillAccount(item, one, group, many),
    )
    pressesIn(made.adds, addsOf(group), group, group)
    made.adds.hidden = made.adds.children.length === 0
    slotIn(
      made.slot,
      wanting !== null && wanting.press.do === 'add' && wanting.group === group.harness,
    )
    textIn(made.why, group.why ? `${group.head} ${group.why}.` : '')
    made.why.hidden = !group.why
  }

  function createAccount() {
    const item = el('li', { class: 'ac-account' })
    const head = el('div', { class: 'ac-head' })
    into(
      head,
      el('span', { class: 'ac-mark', attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'ac-name' }),
    )
    into(
      item,
      head,
      el('span', { class: 'ac-status' }),
      el('span', { class: 'ac-windows' }),
      el('span', { class: 'ac-whose' }),
      el('span', { class: 'ac-install' }),
      el('div', { class: 'presses ac-presses' }),
      el('div', { class: 'ac-slot' }),
    )
    return item
  }

  function fillAccount(item, one, group, many) {
    const [head, status, windows, whose, install, presses, slot] = item.children
    const [mark, name] = head.children
    textIn(mark, one.forNewAgents ? '▸' : '')
    textIn(name, accountName(one))
    textIn(status, statusSaid(one))
    status.classList.toggle('is-on', one.signedIn)
    const used = windowsSaid(one)
    textIn(windows, used)
    windows.hidden = used === ''
    const who = whoseSaid(one)
    textIn(whose, who)
    whose.hidden = who === ''
    textIn(install, one.install ?? '')
    install.hidden = !one.install
    pressesIn(presses, pressesOf(one, many), one, group)
    presses.hidden = presses.children.length === 0
    slotIn(slot, wanting !== null && wanting.press.do !== 'add' && wanting.key === accountKey(one))
  }

  /** A row of presses, each one's word as it stands now (Remove asked once says so). */
  function pressesIn(row, presses, subject, group) {
    keyed(
      row,
      presses,
      (one) => one.id,
      () => pressable('press small'),
      (press, one) => {
        textIn(press, armed === one.id ? (one.again ?? one.word) : one.word)
        press.classList.toggle('quietly', one.quiet === true && armed !== one.id)
        press.classList.toggle('asked', armed === one.id)
        press.classList.toggle('is-danger', one.danger === true && armed !== one.id)
        press.disabled = busy
        RUNS.set(press, () => void pressed(one, subject, group, press))
      },
    )
  }

  /** Where the asking field goes: into the slot it was asked from, and out of every other. */
  function slotIn(slot, here) {
    if (here && ask.parentNode !== slot) slot.append(ask)
    else if (!here && ask.parentNode === slot) ask.remove()
    slot.hidden = !here
  }

  function draw() {
    coming.hidden = answer !== null || refused !== null
    stateBoxIn(
      failed,
      refused === null
        ? null
        : boxOf(
            'error',
            refused.title,
            refused.why ?? refused.fix,
            { word: 'Ask again', run: () => void load(true) },
            refused.steps ?? null,
          ),
    )
    body.hidden = answer === null
    if (answer === null) return
    textIn(again.lastChild, asking ? 'Reading…' : 'Read again')
    again.disabled = asking
    // The tabs: this machine first, then each it links to.
    keyed(
      tabs,
      tabsOf(answer),
      (one) => one.id ?? '',
      () => pressable('ui-chip ac-tab'),
      (press, one) => {
        textIn(press, tabSaid(one))
        press.setAttribute('aria-pressed', one.id === chosen ? 'true' : 'false')
        RUNS.set(press, () => {
          if (one.id === chosen) return
          chosen = one.id
          armed = null
          wanting = null
          trouble = null
          void load(true)
        })
      },
    )
    tabs.hidden = tabs.children.length === 0
    const theirs = answer.machine === chosen
    // What the last press came to, or why it did not happen.
    const problem =
      trouble ?? (answer.trouble && answer.accounts !== null ? notDone(answer.said) : null)
    const line = problem === null && answer.accounts !== null ? (answer.said ?? '') : ''
    answerIn(said, line, problem)
    said.hidden = problem === null && line === ''
    const empty = theirs ? emptySaid(answer) : null
    stateBoxIn(
      nothing,
      !theirs
        ? boxOf('loading', `Asking ${chosen} who its harnesses are signed in as`)
        : empty === null
          ? null
          : boxOf(answer.accounts === null ? 'error' : 'empty', empty),
    )
    groups.hidden = !theirs
    textIn(keys, typeof answer.keys === 'string' ? answer.keys : '')
    keys.hidden = !theirs || keys.textContent === ''
    keyed(
      groups,
      theirs ? harnessesOf(answer) : [],
      (group) => group.harness,
      createGroup,
      fillGroup,
    )
  }

  async function pressed(press, subject, group, from) {
    trouble = null
    if (press.do === 'sign-in') {
      armed = null
      openSignIn(subject.harness, subject.name, accountName(subject), from)
      draw()
      return
    }
    if (press.do === 'remove' && armed !== press.id) {
      armed = press.id
      draw()
      return
    }
    armed = null
    if (press.asks) {
      const asked = askedOf(press, subject, group)
      wanting = {
        press,
        subject,
        group: group.harness,
        key: press.do === 'add' ? null : accountKey(subject),
      }
      textIn(askLabel.firstChild, asked.label)
      field.value = asked.value
      field.setAttribute('type', asked.secret ? 'password' : 'text')
      field.setAttribute('aria-label', asked.label)
      draw()
      field.focus()
      return
    }
    await send(pressBody(press, subject, chosen))
  }

  function openSignIn(harness, account, name, from) {
    void signing().open(from, {
      with: signInWith(harness, account, chosen),
      heading: signInHeading(name, chosen),
      ended: () => void load(true),
    })
  }

  /** One press to the machine, answered with the page as it stands, or why not where it was not. */
  async function send(call, after = null) {
    if (call === null) return
    busy = true
    draw()
    const got = await ctx.ask('POST', ACCOUNTS_PATH, call)
    busy = false
    if (gone) return
    if (got.status === 200 && drawable(got.body)) {
      answer = got.body
      if (!answer.trouble && after !== null) after(answer)
    } else {
      trouble = theirsTrouble(got, ctx.session()) ?? UNKNOWN_TROUBLE
    }
    draw()
  }

  ask.addEventListener('submit', (event) => {
    event.preventDefault()
    if (wanting === null) return
    const { press, subject } = wanting
    const typed = field.value
    const call = pressBody(press, subject, chosen, typed)
    if (call === null) {
      field.focus()
      return
    }
    wanting = null
    field.value = ''
    // An account added goes straight on, as at the machine: a subscription
    // into its own sign-in, an API-key account to its key.
    const added = press.do === 'add' ? typed.trim().toLowerCase() : null
    void send(call, (now) => {
      if (added === null) return
      if (press.kind === 'api-key') {
        const one = (now.accounts ?? []).find(
          (it) => it.harness === subject.harness && it.name === added,
        )
        if (one !== undefined) void pressed(pressesOf(one, true)[0], one, { harness: one.harness })
        return
      }
      openSignIn(subject.harness, added, added, again)
    })
  })
  cancel.addEventListener('click', () => {
    wanting = null
    field.value = ''
    draw()
  })

  // Not full access: refused unasked, but Ask again asks.
  async function load(asked = false) {
    const you = ctx.session()
    if (!asked && answer === null && you != null && !fullAccessOf(you)) {
      refused =
        theirsTrouble({ status: 403, body: { error: 'out_of_scope' } }, you) ?? UNKNOWN_TROUBLE
      draw()
      return
    }
    asking = true
    draw()
    const want = chosen
    const got = await ctx.ask('POST', ACCOUNTS_PATH, lookBody(want))
    asking = false
    if (gone || want !== chosen) return
    if (got.status === 200 && drawable(got.body)) {
      answer = got.body
      refused = null
      // A tab that is not there any more is this machine's again.
      const here = tabHere(chosen, answer)
      if (here !== chosen) {
        chosen = here
        void load(true)
        return
      }
    } else if (answer === null) {
      refused = theirsTrouble(got, ctx.session()) ?? UNKNOWN_TROUBLE
    } else {
      trouble = theirsTrouble(got, ctx.session()) ?? UNKNOWN_TROUBLE
    }
    draw()
  }

  again.addEventListener('click', () => {
    trouble = null
    void load(true)
  })

  draw()
  void load()

  return {
    node,
    update() {},
    leave() {
      gone = true
      sheet?.close()
    },
  }
}
