import {
  candidateSays,
  countsSay,
  dollars,
  ENOUGH,
  minutes,
  type ReplayEntrant,
  sizeBeside,
  spentSays,
} from '@tade/core'
import type { JudgeReplayFact } from '@tade/extensions-core'
import type { ReplaysView } from '../../evaluations.ts'
import type { Skin } from '../../skin.ts'
import { blank, type Row } from '../../ui.ts'
import { cap, padTo } from '../cells.ts'
import type { Line } from '../frame.ts'

// The Evaluations page's Replays tab: each replay, then each case beside its
// original — what came of it, what it cost and took against what the original
// did, and how big its change is beside the original's.
//
// "Could not replay" is drawn quiet and apart from a fail, every time, with
// why under it: a model is never read as worse for a question nobody could
// have answered. Nothing is ranked and nothing is picked — the figures are
// read, and the choosing is the person's.

const GAP = 2
const CASE = 22
const OUTCOME = 18
const MONEY = 15
const TIME = 11

/** The replays, drawn: a heading per replay and a row per case, then the judges asked again. */
export function replaysTab(
  view: ReplaysView | null,
  at: { row: () => Row; skin: Skin; rows: Line[]; inner: number },
): void {
  const { row, skin, rows, inner } = at
  const replays = view?.replays ?? []
  const judges = view?.judges ?? []
  if (judges.length > 0) judgesAskedAgain(judges, at)
  if (replays.length === 0 && judges.length > 0) return
  if (replays.length === 0) {
    rows.push(
      row()
        .space(3)
        .text(
          cap(
            'No replays yet: ask the orchestrator to eval a model or a harness on your own landed work.',
            inner - 4,
          ),
          skin.hint,
        )
        .build(),
    )
    return
  }
  for (const [index, replay] of replays.entries()) {
    if (index > 0 || judges.length > 0) rows.push(blank(inner))
    rows.push(
      row()
        .space()
        .text(cap(`${replay.name} in ${replay.project}`, inner - 2), skin.you)
        .text(
          cap(
            ` · ${candidateSays(replay.candidate)}`,
            Math.max(0, inner - 4 - replay.name.length - replay.project.length),
          ),
          skin.hint,
        )
        .build(),
    )
    rows.push(
      row()
        .space()
        .text(cap(`${countsSay(replay)}.`, inner - 2))
        .build(),
    )
    rows.push(
      row()
        .space()
        .text(
          cap(
            `${spentSays(replay)}${replay.stopped ? ' · the ceiling stopped it' : ''}`,
            inner - 2,
          ),
          skin.hint,
        )
        .build(),
    )
    rows.push(
      row()
        .space()
        .text(padTo('CASE', CASE), skin.label)
        .space(GAP)
        .text(padTo('OUTCOME', OUTCOME), skin.label)
        .space(GAP)
        .text(padTo('COST · WAS', MONEY), skin.label)
        .space(GAP)
        .text(padTo('TIME · WAS', TIME), skin.label)
        .space(GAP)
        .text('SIZE · WAS', skin.label)
        .build(),
    )
    for (const one of replay.entrants) {
      rows.push(entrantLine(one, row, skin, inner))
      if (one.why && one.outcome !== 'passed') {
        rows.push(
          row()
            .space(3)
            .text(cap(one.why, inner - 4), skin.hint)
            .build(),
        )
      }
    }
  }
}

function entrantLine(one: ReplayEntrant, row: () => Row, skin: Skin, inner: number): Line {
  const tone =
    one.outcome === 'passed'
      ? skin.done
      : one.outcome === 'failed'
        ? skin.bad
        : one.outcome === 'running'
          ? undefined
          : skin.hint
  const name = one.of.split('/').slice(1).join('/') || one.of
  const drawn = row()
    .space()
    .text(padTo(cap(name, CASE), CASE), one.task === null ? skin.hint : undefined)
    .space(GAP)
    .text(padTo(one.outcome, OUTCOME), tone)
  if (!one.facts) return drawn.build()
  const was = one.case
  drawn
    .space(GAP)
    .text(padTo(`${dollars(one.facts.usd)} · ${dollars(was?.usd ?? null)}`, MONEY))
    .space(GAP)
    .text(padTo(`${minutes(one.facts.workedMs)} · ${minutes(was?.workedMs ?? null)}`, TIME))
    .space(GAP)
  const used = 1 + CASE + GAP + OUTCOME + GAP + MONEY + GAP + TIME + GAP
  return drawn
    .text(
      cap(
        sizeBeside(one).replace(' (the original ', ' · ').replace(/\)$/, ''),
        Math.max(0, inner - used),
      ),
      skin.hint,
    )
    .build()
}

/**
 * The judges asked again, newest first: what each agreed with and how it
 * stood against the verdicts people wrote — counts, and a rate only from
 * `ENOUGH`, because a judge is never graded by a judge and a rate over two is
 * a fact nobody has.
 */
function judgesAskedAgain(
  replays: readonly JudgeReplayFact[],
  at: { row: () => Row; skin: Skin; rows: Line[]; inner: number },
): void {
  const { row, skin, rows, inner } = at
  rows.push(row().space().text('Judges asked again', skin.you).build())
  rows.push(
    row()
      .space()
      .text(padTo('JUDGE', 26), skin.label)
      .space(GAP)
      .text(padTo('AGREED', 14), skin.label)
      .space(GAP)
      .text(padTo('CONFIRMED CAUGHT', 18), skin.label)
      .space(GAP)
      .text(padTo('DISMISSED RAISED', 18), skin.label)
      .space(GAP)
      .text('COST', skin.label)
      .build(),
  )
  for (const one of replays) {
    const s = one.score
    const used = 1 + 26 + GAP + 14 + GAP + 18 + GAP + 18 + GAP
    rows.push(
      row()
        .space()
        .text(padTo(cap(`${one.judge} · ${one.version}`, 26), 26))
        .space(GAP)
        .text(padTo(counted(s.agreed, s.asked), 14))
        .space(GAP)
        .text(
          padTo(counted(s.confirmed.caught, s.confirmed.of), 18),
          s.confirmed.of === 0 ? skin.hint : undefined,
        )
        .space(GAP)
        .text(
          padTo(counted(s.dismissed.raisedAgain, s.dismissed.of), 18),
          s.dismissed.of === 0 ? skin.hint : undefined,
        )
        .space(GAP)
        .text(cap(dollars(one.costUsd), Math.max(0, inner - used)), skin.hint)
        .build(),
    )
    rows.push(
      row()
        .space(3)
        .text(
          cap(
            `beside ${one.against.join(', ') || 'readings nobody versioned'} · ${s.read} read${s.couldNot > 0 ? `, ${s.couldNot} could not be` : ''}`,
            inner - 4,
          ),
          skin.hint,
        )
        .build(),
    )
  }
}

/** `3/4`, and the rate after it only from `ENOUGH`. */
function counted(n: number, of: number): string {
  if (of === 0) return '—'
  return of < ENOUGH ? `${n}/${of}` : `${n}/${of} ${Math.round((100 * n) / of)}%`
}
