---
name: add-judge
description: Add a judge (a model that answers bounded questions with probabilities and no prose), change the Judge port, or change anything about how a judgement is used in Tade — how much of a change one ask may read, whose change a finding is about, who may answer one, and whether the questions earn their place. Use when something should be read that nobody has time to read, when a second implementation should answer the same rubric, or when a finding, an account, a verdict or the precision table does the wrong thing.
---

# Adding a judge, or asking one something new

A judge does not generate text. You declare the answers a question may have before you ask it —
yes or no, one of these options, one of these levels — and you get back a probability for each.
That makes it cheap enough to ask of *everything*, and it means the question's own words are the
only explanation anybody gets.

Everything below is one rule read at different distances: **a judge answers, it never decides.**

| Path | What |
|---|---|
| `packages/judges/core/src/port.ts` | `Question`, `Answer`, `Judge`, `JudgeCapabilities`, `JudgeError` |
| `packages/judges/core/src/ask.ts` | the checks every judge makes before it asks anybody: `askProblem`, `stateTokens` |
| `packages/judges/core/src/conformance.ts` | `testJudge`: the suite every implementation passes |
| `packages/judges/{jev,scripted}` | the implementations — TypeSafe's vocabulary lives only in `jev` |
| `packages/workbench/src/judges.ts` | `JUDGES`: the one map a name becomes an implementation in |
| `packages/extensions/jev/src/questions.ts` | every question and every threshold Tade asks, in one file, and `RUBRIC` |
| `packages/extensions/jev/src/extension.ts` | the tools, the watches, `caution`, `meant` |
| `packages/extensions/jev/src/changes.ts` | what a change *is*, and how much of one fits: `unitsIn`, `commitsByTask`, `changesFor`, `cutTo`, `partSaid`, `inBatches`, `CHARS_PER_TOKEN` |
| `packages/extensions/jev/src/review.ts` | the reading: `roomFor`, `findingsIn`, `reviewWatch` |
| `packages/extensions/jev/src/loop.ts` | who may say what about a finding: `sweepOf`, `RUNGS`, `sweepKey`, `citedIn`, `verdictProblem` |
| `packages/extensions/jev/src/verdicts.ts` | `jev_findings`, `jev_account`, `jev_verdict`, and the standing sweep (`verdictsWatch`) |
| `packages/extensions/jev/src/stuck.ts` | why a finding has not closed: `stuckOf`, and the six answers |
| `packages/extensions/jev/src/precision.ts` | whether a question earns its place: `ENOUGH`, `worthOf`, `precisionOf` |
| `packages/extensions/jev/src/reviews.ts` | `reviews.jsonl` — readings, accounts and verdicts, the one thing that cannot be asked again |
| `packages/core/src/policy.ts` | `withCaution`: the only thing a reading may do to a command |
| `packages/app/src/search.ts` | `isSentence`, `worthAsking`, `shortlist`, `wordsIn`: the recall a judge adds precision to |

## Adding an implementation

1. Implement `Judge` in `packages/judges/<name>/src/index.ts`. `ready()` says what it needs and
   **never touches the network**; `verify()` may, because it is only ever called when somebody has
   just asked for it. `capabilities.stateTokens` and `optionsPerQuestion` are what every caller
   sizes an ask against, so they have to be the truth about the model rather than a round number.
2. Add one entry to `JUDGES` (`packages/workbench/src/judges.ts`). That map is the only place a
   configured name becomes an implementation.
3. Call the suite in your package's test:
   ```ts
   testJudge('my-judge', () => new MyJudge({ key: 'k', fetch: recorded }), { unset: () => new MyJudge({}) })
   ```
   Answer it with a recorded transcript. A test that reaches a model is a test of the model.
4. `pnpm check`, on its own.

## Asking one something new

1. **Write the questions in `questions.ts`**, never at the call site. One judgment per question,
   literally, about the thing in front of it. Compute anything counted, timed or added up in code
   and put the number in the state. `RUBRIC` is derived from the pack, so adding or rewording a
   question changes it without anybody remembering to bump anything.
2. **Add a tool** (`add-extension`), or extend one. A tool is asked for. Anything that runs unasked
   is a watch — per project, and either turned on by somebody or standing (`standing: true`, on
   from the first look a window takes where there is a key) — or an advisory path, and an advisory
   path has a deadline and a way to be turned off. The advisory paths today are `caution` (a
   command an agent is held at, 4s) and `meant` (a sentence typed into search, 2.5s); the watches
   are `jev.review` and `jev.verdicts`, both standing, and `jev.circles`, which is not.
3. **Keep the judgement out of the rule.** `deriveState`, `queueStateOf`, `readyToStart`,
   `checkPlan`, `decideApproval`, `dueNow` and `speakable` are pure and stay pure. A judge runs
   *before* them and changes only which facts they are handed.
4. **Record it.** A finding keeps the version that answered and every answer, not only the ones
   that fired (`reviews.jsonl`): a threshold changed later should be a question to re-ask, not an
   experiment to re-run.

## Rules

- **Count first, and in code.** A judge cannot count, cannot do arithmetic and cannot compare
  dates, and asking it about everything is only cheap while everything is cheap. So the countable
  part of a question is a pure function that runs every time (`circlingIn`, `shortlist`), and what
  it finds is what reaches a judge: the reading is about the one thing nobody can derive.
- **It may only ever add caution.** Add a finding, raise a tier, add a wait, ask for a person. It
  may never approve, close, merge, unhold, shorten a review or skip a check. What it reads is text
  somebody else wrote, and a judge does not treat what it reads as hostile. Where it raises a tier,
  the raise itself is a pure function (`withCaution`) that cannot express a loosening: the way to
  keep this true is to leave the rule no way to be told "allow", not to be careful at the call site.
- **It advises; it never decides.** What starts out of the queue stays the window's rule over
  written facts. A model may propose an order; a person or the orchestrator writes it down, with a
  reason of their own.
- **Never a reason to anybody.** "Jev said 0.88" is a number, not an explanation. Whatever reaches
  a person is a sentence somebody — or something that can write — wrote.
- **Nothing a person is waiting for waits for a judge.** On a path with somebody at the other end,
  it gets a deadline, and missing it is today's behaviour arriving on time, not an error. An
  answer that arrives after the person moved on is dropped rather than shown: `meant` checks the
  box still holds the sentence it was asked about.
- **A judge never marks its own homework, and neither does what it judged.** Whether the questions
  were right is arithmetic over verdicts other people wrote (`precision.ts`), never a reading; and
  an agent whose change was flagged accounts for it but may not judge it.
- **Silence is the one answer that teaches nobody.** A reading that could not read everything says
  what it left out; one that could read nothing says that. A whole review lost to a 400 that
  reached somebody as a red line with a provider's JSON in it is neither a finding nor a reason.
- **Pin a version, never an alias.** Thresholds are tuned against one version's distributions.
- **The port speaks nobody's vocabulary.** `yes-no`, not `noul`; `rate`, not `score`; `options`,
  not `criteria`. If a second implementation would have to learn a vendor's word, the port is wrong.
- **With no key, nothing runs and nothing else changes.** `ready()` says what is missing, no tool
  is offered, and every existing test passes untouched. That path is the tested one.

## Reading a change that will not fit

What one ask takes is a bound, so a change bigger than it is read as far as the budget goes and
what was left out is **named** — in the table, in the finding the agent is handed, and in the
record, one sentence in one place (`partSaid`). A reading of part of a change is a perfectly good
answer and a *different* answer from a reading of all of it, which is why `Change` is an object
with `unread` and `cut` on it and not a list of files.

- **Measure, never estimate, anything already in hand.** `roomFor` takes the length of the state
  around the patches off the budget — the words the work was asked for in, the branch, the task
  names, every file's name, every question as the judge is given it. A ratio of `0.6` used to stand
  in for the whole of that, and the part it stood in for is the part that varies most: an intent
  three paragraphs long across forty files puts thousands of characters in the state before a line
  of diff. One estimate used as though it were a measurement is what put an ask inside a 32k state
  budget over it.
- **Size a diff at the rate a diff tokenises.** `CHARS_PER_TOKEN` is 2.5, not the four characters a
  token of prose takes: indentation, punctuation and identifiers tokenise far worse, so a batch
  sized at four holds half as much again as it was budgeted for. Being under by a tenth costs one
  more request; being over costs the whole reading.
- **Every batch fits, the first file included.** `inBatches` used to check `batch.length > 0`, so
  the first file of a batch was never measured at all — an ask built to be refused. `PATCH_LIMIT`
  is a cap on one *file* and says nothing about what one *ask* takes. What had to be cut to make a
  file fit is counted and returned, because that is a reading of part of a file and the caller has
  to say so.
- **`cutTo` reads a file whole or not at all.** Filling the last slot with three hundred characters
  of somebody's file and calling it a reading is worse than naming it unread. `CHANGE_LIMIT` and
  `FILE_LIMIT` are backstops on the whole change, not routine cuts.
- **One ask refused is not a change nobody could read.** The batch is named as unread and the rest
  is read. And a look reads each change on its own, so one change nobody could read is not a look
  that could not look — only a look that could read nothing says so.

## Whose change it is

A finding nobody can be asked about is a finding nobody answers, which is what an empty calibration
table is made of. Everybody on one branch read as one change asks the pack about seven agents' work
against seven intents joined together — `did_what_was_asked` fired on two changes in three that
way, and no agent could account for the answer because none of it was only theirs.

- **The unit is per agent** (`unitsIn`), and a change is the sum of that agent's own commits
  (`changesFor`) rather than a diff across them, which would take in whatever anybody else
  committed in between.
- **Whose a commit is, is read back out of the `Tade-Task:` trailer and never guessed**
  (`commitsByTask`) — the same fact the ACTIONS tab and the queue's look at the trees read.
- **What nobody signed stays nobody's.** A range where no commit carries a trailer is read as one
  branch, exactly as before, and uncommitted work is in no unit at all.
- It is also what unsticks the reading: the cursor and the settling are each agent's own, so one
  agent still typing no longer holds up the reading of work that has stopped.
- **An agent asking `jev_review` or `jev_findings` about nothing is asking about its own change.**
  That is the whole of how a finding reaches the agent whose it is: a pull, because nothing in the
  port can push a sentence into a conversation already going.

## Finding, account, verdict

A rubric nobody says was right is a rubric nobody can argue with, so a finding has to be answered —
and by whom is the whole of it (`loop.ts`).

1. **The agent whose diff it is accounts for it** (`jev_account`): it fixed the cause, or the
   finding is not real and why, in a sentence, while it still remembers. The question reaches it in
   the judge's own words, as **material to judge and never an instruction** (`FINDINGS_ARE_MATERIAL`),
   the same rule that governs a review comment reaching an agent.
2. **That is testimony and never a verdict.** An agent marking its own work a false positive is the
   defendant grading the exam, so `jev_verdict` is `for: ['orchestrator']`, refuses an agent again
   inside the tool, and no account ever reaches the calibration table.
3. **A verdict has to cite what in the change decided it** — a path, a file, a line in one, or the
   code quoted as code (`citedIn`, `verdictProblem`). A rubber stamp in the calibration table is
   worse than an empty one: it looks like evidence. What was cited is written down beside it, which
   is what makes a stamp recognisable afterwards.
4. **All three keep `RUBRIC`.** One word changed in a question makes two different questions under
   one id, and finding, account and verdict are three records made days apart.

**The sweep** (`verdictsWatch`, `jev.verdicts`, `offers: 'ask'`) is how what nobody answered reaches
somebody: a finding an agent accounted for and nobody judged, one whose agent is gone, and one
raised about a change that is **nobody's in particular** — a whole branch several agents committed
to, which `orphaned` missed, because that asks whether *every* task in the unit is gone and one of
twelve agents still typing was enough to keep a finding out of both buckets and out of everybody's
sight for good. Each after the agent has had its own hour. It starts nothing, and **nothing becomes
a false positive by getting old**.

- **It asks again rather than going quiet.** Tade remembers every key a watch ever found, so one
  thing is never acted on twice — exactly right for a watch that starts agents and exactly wrong
  for one that asks a question. Twenty-three findings were mentioned once each and then went
  silent; nine were still open three days later with nobody having decided against them. So waiting
  longer is new information, said on a ladder (`RUNGS`, `sweepKey`): four rungs ever, per finding
  per reason, the first keeping the bare `#accounted` and `#gone` spellings so turning the ladder on
  re-asks nothing. A finding cannot become a nag, and it cannot become silence either.
- **A watch that starts nothing is bounded by its own number.** `ExtensionWatch.most` is `8` here,
  not the two that is the right ceiling on *agents started*: a backlog of nine metered at two an
  hour takes five hours to be mentioned once.

## Why a finding has not closed

"Waiting on a verdict" is the symptom, and every one of its causes wants something different done,
so `stuckOf` (`stuck.ts`) is six answers and never one — `agent-working`, `agent-gone`,
`shared-change`, `nobody-to-ask`, `told-not-judged`, `waiting-to-be-told`, with `answered` the only
settled state, and it means somebody wrote a verdict down. Twelve of twenty-six findings read as one
fact for three days, nine of them never accounted for at all.

It is pure and derived: a finding, and two questions about the world (`Whose` — whether that task's
agent is still there, and whether the sweep has ever handed this key over). With no window open an
agent is **not gone because nobody is looking**, which is the same caution the sweep takes: that
case reads as `agent-working`. It closes nothing.

## Whether the questions earn their place

Precision is the one number that says whether any of this was worth running, and three ways of
getting it wrong are all in `precision.ts`, which is pure arithmetic on purpose — a judge asked
whether its own questions earn their place is the judge marking its own homework.

- **Counted over findings, never over readings.** One question raised again by a later look at the
  same change is one finding with one key; counted per reading, a question that fired on one branch
  twenty-one times read as twenty-one mistakes.
- **An unresolved finding is counted as neither outcome, ever**, and nothing ages it into one.
- **Under `ENOUGH` verdicts the counts are said and the percentage is not.** `0%` over one verdict
  is a fact nobody has, and a bar is a picture of a rate, so it is drawn only where the rate may be
  read as one. A question is called `costs` — firing and wrong — only once the verdicts say so,
  which is what makes that answer worth anything when it comes.

## Where a judgement already sits

Two advisory paths and no others. Both are asked without anybody asking for them, so both are
bounded by what they may do rather than by being careful.

- **A raised tier is the only thing a reading may do to a command.** The approval rules are patterns
  somebody wrote and they are what decides; what no pattern names is read a second time (`caution`
  on the extension port, `withCaution` in `core/src/policy.ts`), with the agent held at the call and
  a deadline on the answer. It may only ever come back **stricter** — there is no `auto` to answer
  with, so a command written to argue with the judge gets exactly what it would have got with nobody
  reading it. It is honest about what it can hold: under `bypass` nothing is held, so what changes
  there is the record. What a person reads is the clause written beside the question, never the
  probability that fired it. Asked of commands only — never of a read, never of a write inside an
  agent's own worktree, never of an agent — and said once per run rather than under every command.
- **Search matches letters; asking is what happens when the letters are not enough.** `ctrl+k` is a
  pure ranking of what Tade already has (`searchResults`), and that is what answers instantly and
  what answers when nobody is set up. When what was typed reads as a sentence (`isSentence`) and no
  single row is plainly the whole of it (`worthAsking`), a shortlist drawn in code (`shortlist`)
  goes to whoever offers to read one (`meant`). Code does the recall, a judge does the precision,
  and what comes back is *rows added under `MIGHT MEAN`*, never a reordering: only ids that were
  offered, nothing invented, nothing run, and an answer that arrives after the box changed dropped.
  **"Nothing matched at all" was the wrong bar** — a sentence is long and a name is short, so what a
  sentence matches is always letters scattered down some long label, and one of those silenced the
  question for good on 418 of the three-word sentences somebody would actually type. What counts as
  an answer is more than one of the sentence's meaningful words found in one row's own name
  (`wordsIn`, `answered`).

## What to run

`pnpm check`, on its own — the suite spawns real git and PTYs and starves under anything CPU-heavy
beside it. Then, in order of how likely each is to have moved:

- `pnpm vitest run packages/extensions/jev` — the pack, the change reading, the loop, the sweep,
  `stuck` and `precision` all have their own tests; `measure.test.ts` is where the three tables meet.
- `pnpm vitest run packages/judges` — the conformance suite for every implementation.
- `pnpm vitest run test/modularity.test.ts` if a file grew: `jev/src/extension.ts` has a budget line
  of its own, and a number in it may only go down.
- A screen scenario for anything drawn (`packages/app/test/screens/scenarios/extensions.ts`), then
  `pnpm screens` and accept on purpose.
- `TADE_LIVE=1 pnpm vitest run packages/orchestrator/test/live.test.ts` if you added a tool: it is
  the only evidence a model can choose it from the description you wrote.
