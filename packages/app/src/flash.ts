import { type AppState, ORCHESTRATOR_TAB } from './model.ts'
import type { Entry } from './transcript.ts'

// What the window says back where you are looking.
//
// A press that worked — copied, approved, opened — used to be said only in the
// conversation, which is one tab of the bottom panel: with a terminal in front
// of it, or the panel folded, the answer went where nobody was looking, and a
// click with no answer reads as one that did not land. So an acknowledgement
// is a flash, drawn for a moment in the rule over the foot (`renderFoot`),
// covering nothing and taking no room.
//
// What went wrong is never one. It stays in the conversation, where there is
// room for the reason and it is still there afterwards — nothing goes wrong
// silently — and the conversation's tab says when something landed in it
// while you were looking at something else (`unreadSince`).

/** How long a flash stays: long enough to read a path, and gone before it is in the way. */
export const FLASH_MS = 2_500

/**
 * A press did what it was asked: said where you are looking, for a moment, and
 * not in the conversation. Anything that went wrong, or that somebody has to
 * do something about, is a `notice` instead.
 */
export function acknowledge(state: AppState, text: string, at: number): AppState {
  return { ...state, notice: text, flash: { text, at } }
}

/** What the flash says at `now`, or null once it has gone. */
export function flashing(state: AppState, now: number): string | null {
  const { flash } = state
  return flash !== null && now - flash.at < FLASH_MS ? flash.text : null
}

/** Whether the conversation is where it can be read: its tab in front, and the panel not folded. */
export function conversationShown(state: AppState): boolean {
  return state.bottom === ORCHESTRATOR_TAB && state.bottomMode !== 'min'
}

/**
 * Whether something has landed in the conversation since `read`, the newest
 * line of it a frame drew where it could be read — kept by whoever draws the
 * frames, because only a frame knows what was on screen. Never while it is
 * shown: then it is being read.
 *
 * A line, not a moment: an answer still arriving is a new line each time it
 * grows, so an answer that went on after you left it is something to come
 * back to, and a warning dropped as a repeat (`tadeDid`) is not.
 */
export function unreadSince(state: AppState, read: Entry | null): boolean {
  const newest = state.transcript.entries.at(-1) ?? null
  return newest !== null && newest !== read && !conversationShown(state)
}
