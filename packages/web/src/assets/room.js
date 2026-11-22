// The room the keyboard leaves on a phone.
//
// **iOS does not shrink the page when the keyboard comes up**: the window keeps
// its height and only the visual viewport — what is actually on the glass —
// shrinks to the room above the keyboard. A page whose body is the screen
// (`frame.css`) then has its foot, the box being typed in and the tab bar,
// under the keyboard, and Safari slides the whole page up to show the box,
// taking the header and the top of the conversation off the screen with it.
//
// So while the keyboard is up the shell is the room above it: the root says
// so with `keyboard-up`, `--room` and `--keys`, the body is that tall, the tab
// bar steps aside (it is under the keyboard anyway), and the page is put back
// where it was rather than slid. When the keyboard goes the class goes and the body is
// the screen again. A pinch zoom shrinks the visual viewport too, and is not a
// keyboard: nothing changes while the page is zoomed.
//
// Nothing here knows what device it is on: a browser whose visual viewport
// never shrinks — a desk, Android with its own resize — never sets the class.

/** How much of the window the visual viewport must have lost to be a keyboard rather than a toolbar. */
const KEYBOARD_PX = 120

/** The shell fitted to the room above the keyboard, now and whenever that changes. */
export function roomOn(root = document.documentElement) {
  const view = globalThis.visualViewport
  if (view === undefined || view === null) return
  const fit = () => {
    const zoomed = view.scale > 1.01
    const up = !zoomed && globalThis.innerHeight - view.height > KEYBOARD_PX
    root.classList.toggle('keyboard-up', up)
    if (!up) {
      root.style.removeProperty('--room')
      root.style.removeProperty('--keys')
      return
    }
    root.style.setProperty('--room', `${Math.round(view.height)}px`)
    root.style.setProperty('--keys', `${Math.round(globalThis.innerHeight - view.height)}px`)
    // Undo the slide: the box is in the room now, so nothing needs moving.
    if (globalThis.scrollY !== 0 || view.offsetTop !== 0) globalThis.scrollTo(0, 0)
  }
  view.addEventListener('resize', fit)
  view.addEventListener('scroll', fit)
  fit()
}
