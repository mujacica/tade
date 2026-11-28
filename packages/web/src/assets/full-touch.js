// A finger on the full view (§10 T4 of the Duo plan): what it means, worked
// out on the phone and handed to the window's own face, so nothing waits on
// the machine.
//
// - **A tap is a click**, at the cell under it, looked up in the hit map the
//   last drawing returned (`FarFace.tap`). Two taps on the same cell in quick
//   succession are a double click, as the window counts them.
// - **A vertical swipe is the wheel**: every row's worth of travel is one line
//   through the one move every surface makes (`FarFace.swipe`), over the
//   region the finger started on, and a flick goes on with momentum, slowing
//   as a phone's own lists do, until it stops or another finger lands.
// - **A long press starts a selection**: the page's own, in the DOM, of the row
//   under the finger, which the phone's handles then widen — the machine is
//   never asked to copy, because it would copy onto its own clipboard
//   (`ON_A_PHONE` says so). While a selection is being made the browser has
//   the finger; the bar's Copy puts it on this phone's clipboard.
//
// A mouse on a desk is the same window: a click is a tap and the wheel is the
// wheel, so the page is usable from a laptop's browser too.

/** How far a finger may move and still be a tap, in CSS px. */
const SLOP = 10

/** How long a finger held still is a long press, in ms. */
const HOLD_MS = 450

/** Two taps on one cell within this are a double click, as the window counts one. */
const AGAIN_MS = 350

/** Below this a flick has stopped, in px per ms. */
const STILL = 0.04

/** How much of its speed a flick keeps each frame. */
const KEEPS = 0.94

/** Listen on `node` and say what each touch meant through `to`. */
export function touchOn(node, to) {
  let start = null
  let held = null
  let flick = null
  let last = null

  const stopFlick = () => {
    if (flick !== null) cancelAnimationFrame(flick.frame)
    flick = null
  }

  /** Travel turned into lines, the remainder kept for the next move. */
  const travel = (from, dy) => {
    from.carry += dy
    const rows = Math.trunc(from.carry / to.rowPx())
    if (rows === 0) return
    from.carry -= rows * to.rowPx()
    // A finger going up pulls what is below into view: further down, as a notch is.
    to.swipe(from.cell.x, from.cell.y, -rows)
  }

  node.addEventListener(
    'touchstart',
    (event) => {
      stopFlick()
      if (to.selecting() || event.touches.length !== 1) {
        start = null
        return
      }
      const touch = event.touches[0]
      const cell = to.cellAt(touch.clientX, touch.clientY)
      start = {
        x: touch.clientX,
        y: touch.clientY,
        lastY: touch.clientY,
        at: event.timeStamp,
        lastAt: event.timeStamp,
        speed: 0,
        cell,
        carry: 0,
        moved: false,
        long: false,
      }
      clearTimeout(held)
      held = setTimeout(() => {
        if (start === null || start.moved) return
        start.long = true
        to.longPress(start.x, start.y)
      }, HOLD_MS)
    },
    { passive: true },
  )

  node.addEventListener(
    'touchmove',
    (event) => {
      if (start === null || to.selecting()) return
      const touch = event.touches[0]
      if (touch === undefined) return
      if (!start.moved && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > SLOP) {
        start.moved = true
        clearTimeout(held)
      }
      if (!start.moved || start.cell === null) return
      // The page's, not the browser's: nothing behind the window to scroll.
      event.preventDefault()
      const dy = touch.clientY - start.lastY
      const dt = Math.max(1, event.timeStamp - start.lastAt)
      start.speed = 0.6 * start.speed + 0.4 * (dy / dt)
      start.lastY = touch.clientY
      start.lastAt = event.timeStamp
      travel(start, dy)
    },
    { passive: false },
  )

  node.addEventListener(
    'touchend',
    (event) => {
      clearTimeout(held)
      const was = start
      start = null
      if (was === null || to.selecting() || was.long) return
      if (was.moved) {
        if (was.cell !== null && Math.abs(was.speed) > STILL * 4) coast(was)
        return
      }
      // A tap: the page's own, so no click follows it and no double tap zooms.
      event.preventDefault()
      const cell = to.cellAt(was.x, was.y)
      const again =
        last !== null &&
        cell !== null &&
        event.timeStamp - last.at < AGAIN_MS &&
        last.cell.x === cell.x &&
        last.cell.y === cell.y
      const clicks = again ? Math.min(3, last.clicks + 1) : 1
      last = cell === null ? null : { at: event.timeStamp, cell, clicks }
      to.tap(was.x, was.y, cell, clicks)
    },
    { passive: false },
  )

  node.addEventListener('touchcancel', () => {
    clearTimeout(held)
    start = null
  })

  /** A flick going on after the finger left, slowing each frame. */
  function coast(from) {
    let speed = from.speed
    let at = performance.now()
    const step = (now) => {
      const dt = Math.min(48, now - at)
      at = now
      travel(from, speed * dt)
      speed *= KEEPS ** (dt / 16)
      if (Math.abs(speed) < STILL) {
        flick = null
        return
      }
      flick = { frame: requestAnimationFrame(step) }
    }
    flick = { frame: requestAnimationFrame(step) }
  }

  // A mouse on a desk: a click is a tap, the wheel is the wheel.
  node.addEventListener('click', (event) => {
    if (to.selecting()) return
    const cell = to.cellAt(event.clientX, event.clientY)
    to.tap(event.clientX, event.clientY, cell, Math.min(3, Math.max(1, event.detail)))
  })
  let wheel = 0
  node.addEventListener(
    'wheel',
    (event) => {
      const cell = to.cellAt(event.clientX, event.clientY)
      if (cell === null) return
      event.preventDefault()
      wheel += event.deltaMode === 1 ? event.deltaY * to.rowPx() : event.deltaY
      const rows = Math.trunc(wheel / to.rowPx())
      if (rows === 0) return
      wheel -= rows * to.rowPx()
      to.swipe(cell.x, cell.y, rows)
    },
    { passive: false },
  )
}
