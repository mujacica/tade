import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

// Why the guide is allowed to be the size it is, and why there is no `docs/`.
//
// `AGENTS.md` reached 165,217 characters — 1,786 lines, 140 invariant bullets —
// and Claude Code refused to load it: "CLAUDE.md is over the 150.0k-char limit
// (164.4k chars)". Every agent reads all of it before it touches anything, so
// the file had become the most expensive thing in the repository and the least
// visible: 84 commits touched it in ten days, because the rule inside it told
// every agent that finished work to write its invariant "where the next person
// will read it", and nobody was ever refusing a paragraph in review.
//
// That is `app.ts` reaching 8,635 lines, one file over. The same answer works:
// a number, checked in, that may only go down. A character count cannot tell a
// rule from an essay about a rule. What it can do is make the moment visible —
// the paragraph that crosses the line becomes a conversation, and 140 of them
// arriving one at a time never once was.
//
// The rule the budget enforces is the one that stopped the file growing: an
// invariant in the guide is one or two lines, the rule and where it is
// enforced. Its argument, its measurements and what it used to be go in a
// comment beside that code, in the matching `.claude/skills/` recipe, or in a
// test with a number in it. That is the repository's own principle applied to
// the repository's own guide — what outlives the work lives in the thing that
// fails when it stops being true — and the guide is not that thing for any
// invariant except this one.
//
// `NO_DOCS` is here for the same reason and in the same file deliberately. The
// `docs/` folder has been removed twice, both times because the rule against it
// lived only in prose: "a design document is a plan, and a plan that outlives
// its build is a second description of the system that nothing keeps honest".
// Prose does not fail a build, so the next long plan found nowhere to be and
// invented the folder again. A plan lives in the work (the task, its
// `.tade/context.md`, the agent's conversation), then in the commit and the
// review that carry it across sittings, then in whatever fails when it stops
// being true. A file that only describes, in a folder that only holds
// descriptions, rots in place and is believed anyway.
//
// It runs in `test:smoke`, which is what the commit hook runs: the answer
// arrives while the paragraph is still being written, not an hour later in CI.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const GUIDE = 'AGENTS.md'

/**
 * What the guide is allowed to be, in characters — what the limit that refused
 * it is counted in, so the number here and the number in the refusal are the
 * same kind of thing.
 *
 * This may go DOWN in the commit that earns it, and never up. Reducing it is
 * the same act as lowering a line in `test/modularity.test.ts`: something moved
 * to where it belongs. Raising it is the act this test exists to refuse.
 */
const BUDGET = 30_000

/**
 * How far below the budget the file may sit before the number should follow it
 * down. The half that makes a ratchet a ratchet: without it the budget stays at
 * the day it was written and becomes decoration.
 */
const SLACK = 6_000

/** Folders that may not exist, and what to do instead. */
const NO_DOCS: Record<string, string> = {
  docs: 'Put the reasoning where it is enforced: an invariant in AGENTS.md (one or two lines),\nthe recipe in .claude/skills/, a comment beside the code, or a test with a number in it.\nA plan that seems to need a file of its own is a plan whose reasoning has nowhere to be\ntrue yet — build the smallest piece that makes it true, and put the reasoning there.',
}

/** `165217` → `165,217`, because a six-figure count read as digits is a blur. */
const said = (n: number): string => n.toLocaleString('en-US')

/**
 * The assertion, for all of it: nothing to report is the test passing.
 *
 * Thrown rather than expected, because vitest prints a thrown message as it was
 * written. A budget test that says only that a number went up teaches nobody,
 * so every problem gathered here arrives already saying what to do about it.
 */
function report(problems: string[]): void {
  if (problems.length > 0) throw new Error(`\n\n${problems.join('\n\n')}\n`)
}

/** Repo-relative paths of everything git tracks at the top level. */
function trackedTop(): Set<string> {
  return new Set(
    execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((path) => path !== '')
      .map((path) => path.split('/')[0] ?? path),
  )
}

describe('the guide every agent reads', () => {
  it('is within its budget', () => {
    const chars = readFileSync(new URL(`../${GUIDE}`, import.meta.url), 'utf8').length
    const problems: string[] = []
    if (chars > BUDGET)
      problems.push(
        `${GUIDE} is ${said(chars)} characters, ${said(chars - BUDGET)} over its budget of ${said(BUDGET)}.\n` +
          'Every agent reads all of it before it touches anything, so this is not a file that gets\n' +
          'to grow. An invariant here is one or two lines: the rule, and where it is enforced.\n' +
          'Put the argument, the measurements and what it used to be in a comment beside that code,\n' +
          'in the matching .claude/skills/ recipe, or in a test with a number in it — and take the\n' +
          'paragraph out of the guide in the same commit. BUDGET (test/guide.test.ts) may go DOWN\n' +
          'in the commit that earns it, and never up.',
      )
    if (chars <= BUDGET - SLACK)
      problems.push(
        `${GUIDE} is ${said(chars)} characters and BUDGET says ${said(BUDGET)} — ${said(BUDGET - chars)} of slack.\n` +
          `Lower it in this commit, to around ${said(chars + SLACK)}. This is the ratchet: the budget\n` +
          'only holds while the number follows the file down.',
      )
    report(problems)
  })

  it('is what CLAUDE.md is', () => {
    // One guide, read the same way by every harness. `CLAUDE.md` is a symlink,
    // so a budget on one is a budget on both — and a second file would be a
    // second set of invariants that nothing keeps in step.
    const claude = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8')
    const agents = readFileSync(new URL(`../${GUIDE}`, import.meta.url), 'utf8')
    report(
      claude === agents
        ? []
        : [
            `CLAUDE.md is not ${GUIDE}.\n` +
              `It is a symlink to it, so that every agent reads the same words. Restore it with\n` +
              `\`ln -sf ${GUIDE} CLAUDE.md\` rather than keeping two files that can disagree.`,
          ],
    )
  })

  it('has nowhere for a document that only describes', () => {
    const tracked = trackedTop()
    report(
      Object.entries(NO_DOCS)
        .filter(([folder]) => tracked.has(folder))
        .map(
          ([folder, instead]) => `This repository has a \`${folder}/\` folder again.\n${instead}`,
        ),
    )
  })
})
