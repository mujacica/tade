import type { Target } from '../hits.ts'
import type { ClickAt, Intent } from '../keymap.ts'
import type { PanelOutcome } from '../panels/outcome.ts'

// Where an intent is carried out (`keymap.ts`): the one path from what a key
// asks for to what the window does, whether the key was pressed on the
// machine's own keyboard (`Keyboard.onInput`) or on a phone that draws its own
// copy of the window and sent it through the away door (`wire/far-faces.ts`).
//
// Nothing here decides anything: each intent is handed to the door that has
// always done it. A phone's intent is carried out *as that phone's face*
// (`AttachedFace.as`), so "the agent in front" and "the panel open" are the
// phone's, and the doors read them off `wire.state` as they always have.

/** The doors an intent reaches: the window's own, which the keyboard has always held. */
export interface IntentTargets {
  /** A named action, as a button would run it. */
  run(action: string): void
  /** Answering the agent in front, allowed or not — or the device asking at the away door. */
  decide(allow: boolean): void
  /** Escape with a turn in flight: stop it, and nothing else. */
  interrupt(): void
  /** ctrl+k: the box that finds anything. */
  openSearch(): void
  /** Push-to-talk, held or toggled. */
  talkStart(): void
  talkStop(): void
  /** Close the window, asking first. */
  quit(): void
  /** Keys into the lane with the keyboard, typed or pasted. */
  typeInto(data: string, pasted: boolean): void
  /** A slash command, carried out. */
  act(said: string): void
  /** Anything else: a sentence for Tade. */
  say(said: string): void
  /** What a panel's answer changes. */
  applyPanel(outcome: PanelOutcome): void
  /**
   * A press on something drawn, as the window's own mouse answers one. Only a
   * face that draws somewhere else sends one; the machine's own keyboard never
   * does, so it has none and a click sent to it is refused by name.
   */
  click?(target: Target, button: 'left' | 'right', at: ClickAt): void
}

/** Carry one intent out through the door that does it. */
export function doIntent(intent: Intent, to: IntentTargets): void {
  switch (intent.kind) {
    case 'run':
      to.run(intent.action)
      break
    case 'decide':
      to.decide(intent.allow)
      break
    case 'interrupt':
      to.interrupt()
      break
    case 'search':
      to.openSearch()
      break
    case 'talk':
      if (intent.down) to.talkStart()
      else to.talkStop()
      break
    case 'quit':
      to.quit()
      break
    case 'type':
      to.typeInto(intent.data, intent.pasted)
      break
    case 'say': {
      // A command is carried out here; anything else is a sentence for Tade —
      // the rule `Keyboard.submit` has always had.
      const said = intent.said.trim()
      if (said === '') break
      if (said.startsWith('/')) to.act(said)
      else to.say(said)
      break
    }
    case 'panel':
      to.applyPanel(intent.outcome)
      break
    case 'click':
      if (to.click === undefined) throw new Error('nothing here answers a press on a drawing')
      to.click(intent.target, intent.button, intent.at)
      break
  }
}
