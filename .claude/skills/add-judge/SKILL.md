---
name: add-judge
description: Add a judge (a model that answers bounded questions with probabilities and no prose), change the Judge port, or put a judgement somewhere new in Tade. Use when something should be read that nobody has time to read, or when a second implementation should answer the same rubric.
---

# Adding a judge, or asking one something new

A judge does not generate text. You declare the answers a question may have before you ask it —
yes or no, one of these options, one of these levels — and you get back a probability for each.
That makes it cheap enough to ask of *everything*, and it means the question's own words are the
only explanation anybody gets.

| Path | What |
|---|---|
| `packages/judges/core/src/port.ts` | `Question`, `Answer`, `Judge`, `JudgeCapabilities`, `JudgeError` |
| `packages/judges/core/src/ask.ts` | the checks every judge makes before it asks anybody: `askProblem`, `stateTokens` |
| `packages/judges/core/src/conformance.ts` | `testJudge`: the suite every implementation passes |
| `packages/judges/{jev,scripted}` | the implementations — TypeSafe's vocabulary lives only in `jev` |
| `packages/workbench/src/judges.ts` | `JUDGES`: the one map a name becomes an implementation in |
| `packages/extensions/jev/src/questions.ts` | every question and every threshold Tade asks, in one file |
| `packages/extensions/jev/src/extension.ts` | the tools, the two watches, the second reading of a command, the sentence in search |
| `AGENTS.md` ("A judge answers, it never decides") | the line a judgement may not cross |

## Adding an implementation

1. Implement `Judge` in `packages/judges/<name>/src/index.ts`. `ready()` says what it needs and
   **never touches the network**; `verify()` may, because it is only ever called when somebody has
   just asked for it.
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
   and put the number in the state.
2. **Add a tool** (`add-extension`), or extend one. A tool is asked for. Anything that runs unasked
   is a watch — turned on by somebody, per project — or an advisory path, and an advisory path has
   a deadline and a way to be turned off. The advisory paths today are `caution` (a command an
   agent is held at, 4s) and `meant` (a sentence typed into search, 2.5s); the watches are
   `jev.review` and `jev.circles`.
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
- **Pin a version, never an alias.** Thresholds are tuned against one version's distributions.
- **The port speaks nobody's vocabulary.** `yes-no`, not `noul`; `rate`, not `score`; `options`,
  not `criteria`. If a second implementation would have to learn a vendor's word, the port is wrong.
- **With no key, nothing runs and nothing else changes.** `ready()` says what is missing, no tool
  is offered, and every existing test passes untouched. That path is the tested one.
