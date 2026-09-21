# Running Jev in a loop to perfect a prompt before it reaches an agent

Research only, no code. Numbers are from this machine's journal, frozen at a snapshot of
99,859 events covering **2026-09-13 → 2026-09-21** (8 days, 6,382 priced turns, $742.30).
The journal is being appended to while this is written, so a later reading will differ
slightly; every figure below comes from that one snapshot so they agree with each other.

---

## Verdict

**Not as asked — but three-quarters of the value is available, and the cheap three-quarters
is the part that is safe.**

- A loop of *Jev rewriting prompts* is not doable: Jev cannot write. It returns a
  probability and no prose. The loop needs a second, generating model, and that model is
  where all the cost and all the risk sit — not Jev.
- "To save money on models and AI" does not survive the arithmetic in the direction
  expected. The orchestrator is **2.1%** of spend; prompt *length* is free (97.6% of tokens
  are cache reads). The only channel to real money is making agents do less wrong work.
- **Do the narrow version**: one Jev reading of a briefing *before queued work starts
  unattended*, which may only ever **hold and ask**, never rewrite. Cost ≈ $0.0001, one
  request, no loop, no added latency on anybody's keystroke. It targets the 88% of spend
  that starts hours after the person went to bed.
- **Do not** put a refinement loop between a person pressing enter and anything happening.

---

## 1. What Jev actually is here, plainly

`packages/judges/core/src/port.ts` is unambiguous, in its own opening words:

> A judge does not generate text. You declare the answers a question may have before you
> ask it — yes or no, one of these options, one of these levels — and you get back a
> probability for each. There is no parse step and no rationale.

The three question kinds are `yes-no`, `pick` and `rate`. An `Answer` is a probability, a
picked option, or a level on a scale. There is no field anywhere in the port that can
carry a sentence back, and `JevJudge` posts to `/v1/systemone` and reads `noul`, `choice`
and `score` out of the reply. **There is no shape in which Jev returns an improved prompt.**

So the proposal decomposes into two different components:

| Role | What it needs | Can Jev do it? |
|---|---|---|
| **Write** a better candidate prompt | generation, prose out | **No.** Not a judge. Needs a second model. |
| **Score** a candidate prompt | bounded questions, probability out | **Yes**, natively — `rate` and `pick` exist for exactly this. |

Jev's only possible role in this loop is the **scorer**. Something else — an LLM turn — has
to be the writer. That reframing is the whole of the analysis below, because it moves the
cost and the danger off Jev and onto the generator.

A second, quieter limit matters for a *loop* specifically. From `packages/judges/jev/src/index.ts`:

> It reads its state literally, cannot count, cannot compare dates, and does not treat what
> it reads as hostile.

A loop that rewrites until `underspecified` drops below a threshold is an optimiser pointed
at a judge that does not defend itself. It will find wordings that lower the probability
without adding information — Goodhart's law with a fast, cheap oracle and no counter-pressure.
A judge used as a *gate* is asked once and cannot be gamed; a judge used as a *loss function*
is gamed by construction. This is the strongest technical argument against the loop as such,
independent of money.

---

## 2. The invariant — and the slot that already exists

Two rules stand in the way of the literal proposal:

1. **`intent_spoken` is stored verbatim.** `packages/workbench/src/tasks.ts:242` writes it
   under the comment `// Verbatim: never paraphrased, never normalised.`, the schema
   (`core/src/model.ts:78`) repeats it, and `composePrompt`'s own rules tell the
   orchestrator: *"Record what somebody asks for in their own words. Never paraphrase an
   intent into a tidier one — their wording is the only thing nothing else can reconstruct."*
2. **A judge may only ever add caution.** CLAUDE.md: *"It may only ever add caution: a
   finding, a wait, a raised tier, a person asked. It may never approve, close, merge,
   unhold, shorten a review or skip a check, it is never inside a pure rule, and it is
   never the reason given to anybody."*

A loop that replaces the person's words before an agent sees them breaks the first outright.

**But the refined prompt does not have to live in `intent_spoken` — and already doesn't.**
This is the load-bearing finding of this research. Tade already keeps two separate strings:

| Field | What it is | Written by |
|---|---|---|
| `intent_spoken` | the person's words, verbatim, forever | recorded, never composed |
| `start.prompt` | *"What its agent is told when it starts"* (`core/src/model.ts:66`) | **composed by the orchestrator** |

They reach the agent by two different paths and both are already in this task's own
`task.yaml`. `intent_spoken` is quoted verbatim into the system prompt by
`composeAgentPrompt` — `It was started with: "<intent>"` — while `start.prompt` is delivered
once as `LaunchSpec.opening`, which `harnesses/core/src/port.ts` keeps deliberately apart
from the stored launch line so a relaunch never repeats it.

This file is the proof: `intent_spoken` here is the raw *"5. How about running a Jev in a
loop…"*, and `start.prompt` is a 400-word briefing that names five files to read and four
questions to answer. **Nobody paraphrased anything. A second, better-composed prompt already
exists beside the person's words rather than instead of them.**

So there is a legitimate home for a refined prompt, and the invariant is not actually in the
way — provided the refinement operates on `start.prompt` (Tade's own composition) and never
touches `intent_spoken`. What remains in the way is rule 2, which forbids the *judge* from
being the thing that changes the prompt. A judge can say "this briefing looks
underspecified"; it cannot be the author of the replacement, and its probability can never
be the reason a person is given.

There is already a blessed pattern for exactly this shape. `jev_plan_check` and
`jev_queue_order` read a plan and an order and *advise the orchestrator*, which decides and
writes the reason in its own words — CLAUDE.md: *"which can only make work later; the reason
anybody is given is the sentence Tade wrote."* A briefing gate belongs in that family.

---

## 3. The economics, with arithmetic

### What is actually being spent

| | Amount | Share |
|---|---|---|
| **Total, 8 days** | **$742.30** | |
| Agents | $726.80 | 97.9% |
| Orchestrator | $15.49 | **2.1%** |
| Work **queued** and started unattended (49 tasks) | **$653.35** | **88.0%** |
| Work started interactively (11 tasks) | $73.45 | 9.9% |

| Per task | | Per turn | |
|---|---|---|---|
| median | $6.75 (93 turns) | median | $0.09 |
| mean | $12.11 | mean | $0.12 |
| p90 | $28.30 (237 turns) | p90 | $0.20 |
| max | $105.61 (362 turns) | | |

Of 6,894 `turn_done` events, 6,870 report `ok`, 22 `error` (**0.32%**) and 2 `aborted`.
Turns very rarely fail; they are just sometimes spent on the wrong thing.

### Two premises of the question that the data refuses

**"Save money on models."** The orchestrator — the thing that would run the loop — is 2.1%
of spend. Even making it free saves $15.49 a week. There is no meaningful saving available
on the prompt-writing side; the money is entirely in agent turns.

**"A tighter prompt is a cheaper prompt."** No. The token mix:

| | Tokens | Share |
|---|---|---|
| cache reads | 1,140,242,318 | **97.6%** |
| cache writes | 16,789,038 | 1.4% |
| output | 4,281,751 | 0.4% |
| fresh input | 7,296,306 | **0.62%** |

Average 183,110 tokens per turn. A 600-token briefing against a median task's ~17M tokens
(93 turns × 183k) is **0.0035%** of what the task reads. Shortening a prompt saves nothing
measurable. The *only* way a better prompt saves money is **fewer turns spent on the wrong
work**.

### What the loop costs

Jev is astonishingly cheap. `USD_PER_MTOK = 0.042`, output free, and `questionsPerAsk: 200`
means all 9 `REQUEST_QUESTIONS` are answered in **one** request:

| Ask | State | Cost |
|---|---|---|
| a briefing + projects + running agents | ~2,000 tok | **$0.000084** |
| the state cap | 32,000 tok | $0.001344 |

The generator is ~1,000× more expensive. An orchestrator turn is $15.49 / 176 = **$0.0880**.

```
one round  = generate ($0.0880) + judge ($0.0001)   ≈ $0.088
3 rounds   ≈ $0.264      5 rounds ≈ $0.440
```

**The judging is free; the loop is entirely the cost of the rewriter.** Three rounds cost
about three median agent turns.

### Does it pay?

Three rounds ($0.264) must save ≥3 median agent turns ($0.27) — **3.2% of a median task's
93 turns** — merely to break even. That is not obviously unachievable. But break-even is the
wrong bar, because a refinement can also *mislead*, and the losses are asymmetric: a good
refinement saves a few turns, a bad one can spend a whole task on the wrong thing.

Take a generous assumption — refinement helps **half** the time and saves **10%** of turns:

| Task size | Expected saving | − loop cost | Tolerable rate of harmful rewrites |
|---|---|---|---|
| median, $6.75 | $0.34 | $0.074 | **< 1.1%** (if a bad prompt wastes the task) |
| | | | < 5.4% (if it costs a fifth of one) |
| p90, $28.30 | $1.42 | $1.15 | < 4.1% / < 20% |
| max, $105.61 | $5.28 | $5.02 | < 4.7% / < 24% |

**At the median task the rewriter must mislead less than about 1% of the time.** That is a
demanding bar for a model rewriting a specification without having read the codebase — which
is precisely the position the orchestrator is in when it drafts a briefing. At p90 and above
the margin is comfortable, which is the real signal: *this only makes sense on big work.*

The headline that survives: **the scoring is free and the rewriting is where the risk is.**
An intervention that keeps the free half and drops the risky half is strictly better than
the loop at every task size.

### Is there evidence of waste to recover?

Some, and it is modest. 11 tasks were removed having never been marked done, costing
**$28.34 — 3.8%** of spend. That is the clearest visible pool of abandoned work, and it is
an upper bound on what better briefing could have recovered, not an estimate: tasks get
removed for reasons that have nothing to do with prompt quality. 3.8% of $742 over 8 days is
roughly **$3.50/week** of recoverable waste, against a loop that would cost $0.26 per task
started. With 60 tasks in the window, running the loop on all of them costs **$15.84** to
chase **$28.34** of partially-recoverable waste. That is not a compelling trade at current
task sizes — and it is another reason to target only the expensive tasks.

---

## 4. Latency and failure

### Latency

Measured from the journal, the orchestrator's own turn time: **median 5.2s, p75 13.8s,
p90 31.4s**. A Jev ask is bounded by `timeoutMs ?? 10_000` and is typically far under that.

A 3-round loop on the interactive path, before *anything* visible happens:

```
median   3 × 5.2s   ≈ 16s
p90      3 × 31.4s  ≈ 94s
```

Sixteen seconds of nothing after pressing enter, for a median saving of $0.34 — on a surface
whose own rules say *"Be terse. Spoken replies are heard through one earbud while somebody is
walking."* The person's messages here are median 267 characters; they are typing quick
corrections and expecting the room to respond. **This is disqualifying for interactive
messages on its own, before any of the money.** A person who is right there can simply say
more, and does: 51 `said` events across 60 tasks.

### Failure

`JevJudge.post` retries twice (`retries ?? 2`) on 429/529/unreachable, each attempt under a
10s timeout with ~500ms backoff — worst case **~31s per ask** with a dead network. Three
rounds of that is ~95s of silence before falling back.

The failure modes and what each must do:

| Failure | Current behaviour in the code | What the loop must do |
|---|---|---|
| **No key** | `ready()` returns a sentence, never touches the network, checked on every load | Send the prompt as written. Say so once, not per prompt. |
| **No network** | `JudgeError(retryable: true)` after 3 attempts | Send as written. Degrade silently-but-recorded. |
| **Judge refuses / state over budget** | `askProblem` refuses rather than truncating | Send as written. Never truncate a briefing to fit. |
| **Will not converge** | nothing — the loop would have to own this | **Hard cap at 2 rounds**, then send the best candidate and say it did not settle. |

The convergence question deserves its own answer: **a judge gives a probability, not a
gradient.** There is no signal telling the rewriter *which way* to move, only whether the
last attempt scored better. With no key and no network the whole feature must vanish
without changing any outcome — CLAUDE.md already requires this of Jev (*"with no key nothing
runs and nothing else changes"*) — which means the loop can never be load-bearing, and
anything that is not load-bearing should be as small as possible.

---

## 5. Where it might genuinely pay

The economics and the latency point at the same place from opposite directions.

**It pays where nobody is watching and the work is large.**

- **Queued work that starts hours later — 88% of spend, $653.35, mean $13.33 per task
  (twice the $6.68 interactive mean).** The briefing was written when the plan was made; the
  work starts when a slot opens. Nobody is waiting on a keystroke, so 16 seconds is free.
  If the briefing is underspecified, there is no one awake to notice, and the agent burns a
  mean of $13.33 finding out. **This is the whole case.**
- **Plan `touches` guesses.** Already handled better by code than by a judge: `lookAtTrees`
  and `collidesNow` read the actual tree at the moment of starting. `jev_plan_check` already
  asks the judge about pairs. Nothing to add here.
- **A retry after a failed turn.** 22 errored turns in 6,894 (0.32%). Too rare to be worth
  a mechanism.
- **Interactive messages — do not.** The person is present, latency is the dominant cost,
  and `jev_read_request` already covers the useful part of this in one cheap call.

Note that 52 of 62 tasks were created by the orchestrator ($698.46 of the spend). The
orchestrator is already writing nearly every briefing on this machine. It does not need a
loop to write a better one — it needs to be *told when its draft looks thin*, once, before
the work is queued.

---

## 6. Recommendation — a narrower version, and a free experiment first

### Do not build

- A loop between a person's message and the orchestrator's reply.
- Any component that rewrites `intent_spoken`, or that quietly substitutes a generated
  prompt for a person's words anywhere.
- A judge used as a loss function to optimise against.

### Do build (small)

**One reading of a drafted briefing before queued work is committed to, which may only hold
and ask.**

- **Where:** a `jev_*` tool, `for: ['orchestrator']`, called while the orchestrator is
  drafting `start.prompt` — inside a turn it has already paid for. No loop, one ask,
  **$0.0001**, no latency added to anybody's keystroke.
- **What it asks:** the existing rubric is already close. `underspecified`,
  `ambiguous_work`, `needs_decision` and `wants_them_present` are the four that matter for
  a briefing that will run unattended. `wants_them_present` is the highest-value question
  in the set: work that needs somebody awake should not start at 3am regardless of how well
  it is worded.
- **What it may do:** exactly what `jev_plan_check` and `jev_queue_order` may do — advise.
  The orchestrator fixes its own draft, or asks the person, in its own sentence. The
  probability is never what anybody reads. It never rewrites, never starts, never unholds,
  and it is not inside `readyToStart`.
- **Why this is the right 90%:** it keeps the free, safe half (scoring) and drops the
  expensive, risky half (rewriting). It aims at the 88% of spend that starts unattended. And
  the person is not made to wait for any of it.

### Test it for nothing before building anything

`jev_read_request` already exists, is already wired to the orchestrator, and already asks
all nine `REQUEST_QUESTIONS` in one request. **The orchestrator can call it on its own draft
briefing today** — passing the drafted `start.prompt` as `said` — with no code written at
all. That is a slight misuse of a field described as "what they said, word for word", but
the questions are phrased about *"the words below"* and will answer.

Run that on the next dozen queued briefings and record what happens with `jev_verdict`,
which exists precisely for this: *"the half of the record the judge cannot give — without it
there is no way to say whether any of this was worth running, and a question that is always
wrong cannot be found and deleted."*

If `underspecified` fires on briefings that then went badly, there is a feature here worth
the tool call. If it fires on everything, or nothing, the rubric needs different questions —
and that is a cheap thing to learn before building a mechanism around it.

### What would change this answer

- **Task sizes growing.** At p90 ($28.30) and above the margin is already comfortable. If
  the median task moved toward $30, a real refinement loop — with a generator — would start
  to pay even with a pessimistic harm rate.
- **A cheap generator.** The arithmetic assumes the rewriter is Opus at $0.088/turn. At a
  tenth of that, three rounds cost $0.026 and the break-even drops from 3.2% of a task to
  0.3%. The journal shows no cheap tier in routine use to price this against.
- **Evidence from the free experiment above** that briefings which score badly actually do
  go badly. Everything here assumes that link; nothing in the journal proves it yet.

---

## Sources

| Claim | Where |
|---|---|
| A judge cannot generate text | `packages/judges/core/src/port.ts` |
| Jev price, limits, retries, 10s timeout | `packages/judges/jev/src/index.ts` |
| The rubric, `REQUEST_QUESTIONS`, thresholds | `packages/extensions/jev/src/questions.ts` |
| `jev_read_request`, `jev_plan_check`, `jev_verdict` | `packages/extensions/jev/src/extension.ts` |
| `intent_spoken` written verbatim | `packages/workbench/src/tasks.ts:242`, `packages/core/src/model.ts:78` |
| `start.prompt` is a separate, composed string | `packages/core/src/model.ts:60-73` |
| Opening said once, kept out of the stored launch line | `packages/harnesses/core/src/port.ts:582-590` |
| Agent prompt quotes the intent verbatim | `packages/core/src/compose.ts:209` (`composeAgentPrompt`) |
| Judges add caution only; advise, never decide | `CLAUDE.md`, "A judge answers, it never decides" |
| All spend, latency and turn figures | `<home>/events.jsonl`, snapshot of 99,859 events, 2026-09-13 → 2026-09-21 |
