import type { CommentTo, LineComment } from '../comments.ts'
import { sameTo } from '../comments.ts'
import type { Hit } from '../hits.ts'
import { Row } from '../ui.ts'
import type { PanelContext } from './context.ts'
import { typed } from './outcome.ts'

// Writing a comment on a line of a diff: one row the panel gives up, the way
// the file viewer's find bar takes one, so the panel keeps its height and
// nothing under the pointer moves. Both diff surfaces — the file viewer with
// its changes drawn in, and the patch reader — open this same box, so a
// comment is written the same way wherever the line is.
//
// What it becomes once kept, and where it goes, is `comments.ts`'s.

/** A comment being written: the line it is on, and what has been typed so far. */
export interface Composing {
  /** The line as the panel draws it. */
  line: number
  side: 'new' | 'old'
  /** The number git gave it, which finds its hunk — null for a line typed since git was asked. */
  git: number | null
  /** The line itself, the context where git drew no hunk round it. */
  text: string
  words: string
  /** Tade unless somebody chose an agent: the person's default, said by them. */
  to: CommentTo
}

/** Who a comment can go to, and what the box calls each: Tade first, then the agents. */
export interface CommentChoice {
  to: CommentTo
  label: string
}

/**
 * The box opened on a line: empty and to Tade, or holding the comment already
 * kept there, so writing on a line again is changing what it says.
 */
export function composeOn(
  at: Pick<Composing, 'line' | 'side' | 'git' | 'text'>,
  kept: Pick<LineComment, 'words' | 'to'> | null,
): Composing {
  return { ...at, words: kept?.words ?? '', to: kept?.to ?? 'tade' }
}

/** What a key did to the box: still writing, kept, or closed. */
export type ComposeAnswer = { composing: Composing } | { done: 'keep' | 'cancel' }

/**
 * A key while the box is open. Enter keeps it — and keeping nothing takes back
 * a comment the line had; tab says who it goes to, starting from the agent the
 * change is whose; escape closes it and keeps nothing.
 */
export function composeKey(
  box: Composing,
  key: string | undefined,
  data: string,
  choices: readonly CommentChoice[],
): ComposeAnswer {
  if (key === 'escape') return { done: 'cancel' }
  if (key === 'enter') return { done: 'keep' }
  if (key === 'tab' || key === 'shift+tab')
    return { composing: { ...box, to: nextTo(box.to, choices, key === 'tab' ? 1 : -1) } }
  if (key === 'backspace')
    return { composing: { ...box, words: [...box.words].slice(0, -1).join('') } }
  if (key === 'ctrl+u') return { composing: { ...box, words: '' } }
  const text = typed(data, key)
  return text ? { composing: { ...box, words: box.words + text } } : { composing: box }
}

/** The next one who could be told, round and back to Tade. */
export function nextTo(to: CommentTo, choices: readonly CommentChoice[], by: 1 | -1): CommentTo {
  if (choices.length === 0) return to
  const at = choices.findIndex((one) => sameTo(one.to, to))
  const next = (Math.max(0, at) + by + choices.length) % choices.length
  return choices[next]?.to ?? to
}

/** What the box calls where a comment goes. */
export function toLabel(to: CommentTo, choices: readonly CommentChoice[]): string {
  return choices.find((one) => sameTo(one.to, to))?.label ?? (to === 'tade' ? 'Tade' : to.agent)
}

/**
 * The box, on one row: the line it is on, the words, and who they go to —
 * a chip, pressed to say somebody else, as tab does.
 */
export function commentBar(
  box: Composing,
  where: string,
  inner: number,
  ctx: PanelContext,
): { text: string; hits: Hit[] } {
  const { skin } = ctx
  const control = (id: string) => ({ kind: 'control' as const, id })
  const label = toLabel(box.to, ctx.commentTo ?? [])
  const fixed = where.length + label.length + 'Keep'.length + 'Close'.length + 24
  return new Row(inner, skin, ctx.pointer)
    .space()
    .text(where, skin.label)
    .space()
    .field(box.words.replaceAll('\n', ' ⏎ '), Math.max(12, inner - fixed), { caret: true })
    .space()
    .text('to', skin.hint)
    .space()
    .chip(label, control('comment-to'), box.to === 'tade' ? 'rest' : 'primary')
    .right((r) =>
      r
        .button('Keep', control('comment-keep'), 'primary')
        .space()
        .button('Close', control('comment-shut'))
        .space(),
    )
    .build()
}

/** The mark down the side of a line a comment is kept on. */
export const COMMENTED = '•'
