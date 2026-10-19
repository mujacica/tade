// A conversation read back to its beginning, as a chat is: scrolling up near
// the top of what the page holds asks the machine for what was said before,
// and what arrives goes above **without moving what the reader is looking
// at**. The conversation with Tade (`talk.js`) and an agent's
// (`pages/agent-said.js`) both read back with this, so nothing said is only in
// the window.
//
// **Every line a page was ever sent is kept** while the screen is open
// (`linesKept`): the snapshot carries the newest stretch, and when the
// conversation grows that stretch moves on — so a page that drew only what the
// last answer held would lose the lines between it and what was read further
// back.
//
// **Only going up asks.** The screen opens at its foot, and the scroll that
// puts it there passes the top on its way; a reader going up near the top is
// what asks, or a conversation too short to scroll at all.

import { el } from './dom.js'

/** How near the top counts as reaching it, in pixels: a screen of lines before it. */
export const NEAR_TOP = 600

/** Whether a region scrolled this far is near enough its top to read further back. */
export function nearTop(scrollTop, slack = NEAR_TOP) {
  return scrollTop <= slack
}

/**
 * The lines a screen holds, by id, in the order they were said.
 *
 * `order` compares two lines where their ids sort in that order (Tade's do);
 * without it the order is the order they arrived in — what came after
 * everything held goes at the foot, what was read further back at the top.
 */
export function linesKept(order) {
  const byId = new Map()
  let ids = []
  return {
    /** What a newest answer carries: changed in place, or after everything held. */
    newer(rows) {
      for (const row of rows) {
        if (!byId.has(row.id)) ids.push(row.id)
        byId.set(row.id, row)
      }
    },
    /** What was read further back: above everything held, in its own order. */
    older(rows) {
      const fresh = rows.filter((row) => !byId.has(row.id))
      for (const row of rows) byId.set(row.id, row)
      ids = [...fresh.map((row) => row.id), ...ids]
    },
    /** Every line held, oldest first. */
    all() {
      const rows = ids.map((id) => byId.get(id))
      return order === undefined ? rows : rows.sort(order)
    },
    /** The oldest line held, which the page before is asked by. */
    first() {
      const rows = this.all()
      return rows.length === 0 ? null : rows[0]
    },
    get size() {
      return byId.size
    },
  }
}

/**
 * Reading back as the reader scrolls up in `region` (a function, because Tade's
 * region is the frame's `main`, which a screen is put into after it is built).
 *
 * `load` reads the page before and puts it in, calling `keep` around the
 * drawing so the view stays where it was; it answers `'read'`, `'none'` (the
 * beginning) or `'failed'`. The node it returns goes at the top of the
 * conversation: a line while a page is being read, and a press to read again
 * where one could not be — the window's own words for both.
 */
export function readBack(region, load) {
  const node = el('div', { class: 'chat-back' })
  const reading = el('p', {
    class: 'chat-reading',
    text: 'reading what was said before',
    attrs: { role: 'status' },
  })
  const again = el('button', {
    class: 'press chat-again',
    text: 'Read what was said before',
    attrs: { type: 'button' },
  })
  node.append(reading, again)
  let more = false
  let busy = false
  let stalled = false
  let held = null
  let lastTop = 0

  const at = () => {
    const now = region()
    if (now !== held && now !== null && now !== undefined) {
      held?.removeEventListener('scroll', heard)
      held = now
      lastTop = now.scrollTop
      // Passive: reading where somebody is never holds their scrolling up.
      now.addEventListener('scroll', heard, { passive: true })
    }
    return held
  }

  /** What there is to say at the top — drawn inside `keep`, so its showing moves nothing. */
  const paint = () => {
    node.hidden = !(busy || stalled)
    reading.hidden = !busy
    again.hidden = busy || !stalled
  }

  /** Draw something above the view, and leave the view on what it was showing. */
  const keep = (draw) => {
    const one = at()
    if (one === null) {
      draw()
      return
    }
    const height = one.scrollHeight
    const top = one.scrollTop
    draw()
    const grown = one.scrollHeight - height
    if (grown !== 0) one.scrollTop = Math.max(0, top + grown)
    lastTop = one.scrollTop
  }

  const go = async () => {
    if (busy || !more || stalled) return
    busy = true
    keep(paint)
    const got = await load(keep)
    busy = false
    stalled = got === 'failed'
    if (got === 'none') more = false
    keep(paint)
    // Still near the top with more to read — a short page, or a fast thumb.
    requestAnimationFrame(() => look(true))
  }

  /** Whether to read further back now: going up near the top, or nothing to scroll. */
  function look(after) {
    const one = at()
    if (one === null || !more || busy || stalled) return
    const short = one.scrollHeight - one.clientHeight < NEAR_TOP
    if (short || (after && nearTop(one.scrollTop))) void go()
  }

  function heard() {
    const one = at()
    if (one === null) return
    const top = one.scrollTop
    const up = top < lastTop - 1
    lastTop = top
    if (up && nearTop(top)) void go()
  }

  again.addEventListener('click', () => {
    stalled = false
    void go()
  })
  paint()

  return {
    node,
    keep,
    /** Whether the machine says there is more before what is held. */
    more(said) {
      if (more === said) return
      more = said
      keep(paint)
    },
    /** After a paint: read further back where the conversation is too short to scroll. */
    drawn() {
      look(false)
    },
    /** The screen is gone: stop listening to a region that outlives it. */
    leave() {
      held?.removeEventListener('scroll', heard)
      held = null
    },
  }
}
