# Jev in Tade

A proposal. Nothing here is built. Written 2026-09-18, against `jev-1.13` (released 2026-09-15,
three days old at the time of writing). **Sections 1–9 change no existing code** — they are one
extension and a judge port beside it. **Sections 10–16 do**, in a handful of named places, and each
says exactly which file and exactly what stays as it is.

Revised 2026-09-18 after arguing it through: ask and grep moved to the front and became the
foundation, the Sentry-specific tools were dropped (triage is `jev_ask` pointed at what Sentry
already returns), the review loop changed its unit, its moment and the way it raises what it finds,
and the record it leaves got a section of its own.

Revised 2026-09-19, with a key in hand and before anything is built, to answer the question the
first two drafts did not: **where else does this belong?** Sections 10–16 are new. They put Jev
where the decisions are — how a request is read, whether two agents may run at once, what the queue
does next, whether an agent is going in circles — and then draw the line it may not cross, because
every one of those decisions is either a person's, the orchestrator's, or a rule the window applies
without asking anybody. Section 10 is that line, in a table; section 15 says plainly where Jev would
not help and where it would hurt; section 16 is the optional key in the setup wizard, with the
no-key path written out per piece, because **everything in here has to keep working for somebody who
never sets a key, and that path is the tested one.**

Sources, so a later reader can check what has moved: the writeup we were handed
([Anthony Maio, *Jev: The Language Model That Won't Talk*, 2026-09-16][writeup]), TypeSafe's launch
post ([*Introducing System One Models & Jev*, 2026-09-15][launch]), the docs
([docs.typesafe.ai][docs], including [Models][models], [API reference][api], [Confidence][conf] and
[Jev 1.13 jaggedness][jag], last reviewed by them 2026-09-17), their [workflow evals site][evals],
and the SDKs on npm/PyPI. **[What I could not verify](#what-i-could-not-verify) is its own section at
the end — read it before quoting any number in here.**

[writeup]: https://anthonymaio.substack.com/p/jev-the-language-model-that-wont
[launch]: https://typesafe.ai/blog/introducing-system-one-models-and-jev
[docs]: https://docs.typesafe.ai/
[models]: https://docs.typesafe.ai/models
[api]: https://docs.typesafe.ai/api
[conf]: https://docs.typesafe.ai/confidence
[jag]: https://docs.typesafe.ai/model-jaggedness/jev-1.13
[evals]: https://evals.typesafe.ai/

---

## 1. What Jev is, and what it won't do

Jev is a model from TypeSafe AI (founder Diogo Almeida, an equal-contribution primary author on the
InstructGPT paper) that **does not generate text**. Not "is discouraged from": there is no string in
the response. You send one `state` and a map of typed questions; you get back one typed answer per
question, each with a probability distribution. TypeSafe calls the class "System One models" and the
training objective RLCD — Reinforcement Learning for Calibrated Decisions, as against RLHF (human
preference) and RLVR (verifiable reward).

Three question types, all three mixable in one request, all evaluated **in parallel against the same
state**:

| Type | Asks | Answers with |
|---|---|---|
| `noul` | a yes/no proposition | `noul`: the probability it is true, 0–1 |
| `choice` | pick one of the options you declared | `choice`, `probabilities` over every option, `confidence` |
| `score` | rate against ordered levels you declared | `score` (probability-weighted, lands between levels), `legend`, `probabilities`, `confidence` |

```json
POST https://api.typesafe.ai/v1/systemone
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "jev-latest",
  "questions": {
    "is_urgent": { "type": "noul", "instructions": "Does this convey urgency?" },
    "department": { "type": "choice", "instructions": "Which team should handle this?",
                    "criteria": { "billing": "Payments, invoicing, refunds",
                                  "technical": "Bugs, outages, integrations" } }
  }
}
```

**The novelty, stated precisely.** Not "cheap and fast", though it is both. It is that the output
space is declared by the caller before the call, so:

1. **No parse step, and no class of integration failure that comes from one.** The model cannot
   invent a field, emit malformed JSON, refuse, apologise, or wander into prose. TypeSafe's claim
   that it "can't hallucinate" is only this, and their own docs say so: *"Jev constrains the shape of
   the output. It does not constrain the judgment."* It will still pick the wrong option with a
   confident-looking number on it.
2. **Uncertainty is a first-class part of the answer, not a sentence you have to believe.** `confidence`
   is derived from the shape of the distribution; you get the raw `probabilities` too, so you can
   compute your own statistic. RLCD's stated aim is that when Jev says 0.8 it is right about 80% of
   the time across a population of such answers — calibration, not per-answer correctness.
3. **Questions are independent, so you decompose instead of prompting.** Adding a question to a
   request barely changes latency and does not cost context rot, because each is evaluated in
   isolation against one shared state. The policy — thresholds, weights, what happens next — lives in
   your code, under review, in one file, rather than inside a paragraph of prompt.

**Why that matters for review and triage work specifically.** Both are a large number of small
bounded judgments over material nobody will read otherwise: every commit, every log line, every new
issue. With a generative reviewer you pay a model turn for each one (seconds, cents, and a paragraph
to parse), so in practice you review a sample and hope. With Jev, the per-unit cost of asking is
small enough that you can ask of everything, and the answer arrives as a number you can threshold —
which is the only honest way to decide "does this deserve a human, an agent, or nothing". The thing
we currently cannot do is not "review a diff well" — a frontier model does that better than Jev
will. It is **review every diff at all**, and rank what comes out.

The other half of the same coin, and the reason not to get carried away: Jev gives you **no
explanation**. A finding is a question id and a probability. Whoever acts on it — an agent, a person —
needs the diff and a good question title, because there is no rationale to read. That is a design
constraint on everything below: the question text *is* the explanation, so questions must be written
to be read by the person who gets woken by them.

TypeSafe's own list of where it is weak ([jaggedness][jag], their word) is short and directly
relevant to us: it reads instructions literally; it cannot count or do arithmetic or compare dates;
it degrades with indirection ("a property of a property"); accuracy falls as the state fills with
material the question does not need; **it does not treat state as hostile** — content written to
steer it can steer it; and structural invariants you would expect (a noul and its negation summing
to 1) do not hold. Every one of those has a consequence in sections 3 and 4.

---

## 2. Providers, auth, cost, limits — and the Tade entry

### Who serves it

**Only TypeSafe, directly, in selective early access with a waitlist** (and a Discord). I checked:

- **OpenRouter:** not there. I fetched `https://openrouter.ai/api/v1/models` on 2026-09-18: 445
  models, no `jev`, no `typesafe`, no mention in any entry.
- **Anthropic / Bedrock / Together / Fireworks:** no public listing or announcement found. Together's
  and Fireworks' catalogues need a key to enumerate, so that is "found no evidence", not "verified
  absent" — but see below for why it would be surprising.
- **Direct:** `POST https://api.typesafe.ai/v1/systemone`, plus `GET /v1/models`.

There is a structural reason to expect this to stay true for a while: the endpoint is **not
OpenAI-compatible and not a chat completion at all**. A gateway that multiplexes `/chat/completions`
has nothing to route here; serving Jev means implementing a second, unrelated API shape. Aggregators
will carry it when it is worth their while, not automatically. Plan for one provider.

What does exist, and is worth knowing: TypeSafe publish an MIT-licensed
[`system-one-adapter-python`](https://github.com/typesafe-ai/system-one-adapter-python) — the same
`system_one` call implemented on top of OpenAI or Anthropic with structured outputs, meant for
comparing them. That is a ready-made argument (and prior art) for the fallback implementation in
section 7.

### Auth, SDKs, errors

| | |
|---|---|
| Auth | `Authorization: Bearer <API_KEY>`; key from `TYPESAFE_API_KEY` |
| Env | `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`), `TYPESAFE_DEFAULT_MODEL` (default `jev-latest`) |
| JS SDK | `@typesafe-ai/sdk` 0.6.0, MIT, `node >= 20`, ESM+CJS+types, published 2026-09-15 |
| Python SDK | `typesafe-sdk` 0.6.0, MIT, `>=3.10` |
| Errors | `401` bad key · `422` malformed question/state, body names the field · `429` rate limited · `529` overloaded |
| Retries | SDK default: 2 retries, 500ms → 5s backoff, 25% jitter, honours `Retry-After`; 10s timeout per attempt |

### Cost and limits (all provider-reported, 2026-09-17)

| | `jev-1.13.0` |
|---|---|
| Input | **$0.042 / MTok** ($42 per billion) |
| Output | **free** ("too cheap to meter") |
| Rate limits | 250,000 tokens/sec, 1,200 requests/min — TypeSafe warn these "can change without notice" |
| Context | 64k tokens per request (state + all questions); 32k for state + the single longest question |
| Input kinds | text only: string, JSON object, or array of strings. No images, audio, binaries |
| Latency | 70–500ms claimed; 0.3–0.5s per case in their own evals |
| Aliases | `jev-latest` → `jev-1.13.0`; `jev-preview` → same today |
| Training on your data | no, per their Models page; ZDR offered to enterprise |

Note one inconsistency in their docs: [Models][models] says 64k per request, while
[Primitives](https://docs.typesafe.ai/primitives) says "around 32,000 tokens, roughly 150,000
characters". Assume 32k of usable state until measured.

Their own eval numbers (four workflows, reference labels = average of GPT-6 Astra and Claude Fable
5.1 at high reasoning — so a consensus-with-the-big-models score, not ground truth):

| | mean accuracy | $/case | s/case |
|---|---|---|---|
| Jev (in a workflow) | 67.8% | $0.0004 | 0.4 |
| GPT "terra" (workflow) | 67.9% | $0.0304 | 10.1 |
| Claude Sonnet 5 (workflow) | 67.8% | $0.1174 | 78.1 |
| GPT "sol" (workflow) | **74.1%** | $0.0836 | 23.3 |
| Claude Opus 5 (workflow) | 73.1% | $0.1761 | 37.8 |

Two of their four workflows are *security incident response* (Jev 61.7% vs Opus 66.2%, sol 62.5%) and
*agent trace observability* (Jev 71.6% vs sol 76.6%, Opus 75.2%) — which is exactly the shape of work
in sections 3 and 4, and says plainly that Jev is **competitive but not best** at it. The honest
reading: Jev is a filter, not a reviewer. The frontier models are 5–10 points better and 100–400x the
cost per case; the win is that you can afford to run Jev on everything, and spend a frontier model
only on what Jev hands you.

A note their evals make before they make any point about Jev, and which we should take separately:
**every** model was more accurate, cheaper and faster decomposed into a workflow than prompted to
execute the whole policy. That is an argument for decomposition, not for Jev, and it is free.

### What a Tade entry looks like

**Jev is not a `workers.routes` entry and must never become one.** A route is how an agent runs —
`harness`, `provider`, `model`, `thinking`, `sandbox` — and every one of those assumes something that
generates text and calls tools. Jev cannot hold a conversation, cannot call a tool, cannot write a
patch. Putting `model: jev-latest` in a route would produce an agent that dies on its first turn.
Same for `orchestrator.model`.

It is **an extension's settings**, like Sentry's, with the key out of the environment and never in a
file:

```toml
[extensions.jev]
# The model that answers. Pin the version, not the alias: confidence thresholds are
# tuned against one version's distributions, and an alias moves under you.
model = "jev-1.13.0"
# The environment variable the key is in, when it is not TYPESAFE_API_KEY.
key_env = "TYPESAFE_API_KEY"
# A TypeSafe you point at instead, for a proxy or a replay in tests.
url = "https://api.typesafe.ai"
# What a question's probability has to reach before it is a finding, and before
# work is started rather than the orchestrator asked. Two numbers, in one place.
report = 0.6
act = 0.85
# What one look at a project may spend, so a bad day cannot run away: requests.
budget = 200
```

The deeper integrations (sections 11–14) each bring one more key, and **not one of them is written
until the thing that reads it exists** — a setting Tade accepts and ignores reads like a promise:

```toml
# What it may weigh in on, unasked. Each is off unless named here; the tools
# (jev_read_request, jev_plan_check, jev_queue_order) are always there to call.
# Read by: the window, before it speaks to the orchestrator (§11) · the workers
# that watch turns (§14.1) · the approval pass (§14.2).
advise = ["requests", "turns"]
# How long anything on a path somebody is waiting on may take before Tade gives
# up and does exactly what it does today. Milliseconds. Read by: §11, §14.2.
deadline = 400
# Projects it may look at. Nothing is sent from a project not named here.
# Read by: every tool and watch that reads a diff.
projects = ["tade"]
```

`advise` is a list rather than a flag because the paths differ in what they cost and what they risk:
`requests` is one call a turn on the thing you are talking to, `turns` is one call per agent turn,
`approvals` is one call per unmatched shell command. Somebody should be able to want the first and
not the third.

`ready()` returns "set `$TYPESAFE_API_KEY`…" when there is no key — no network, per the extension
rules. Everything else (`org`-equivalents, per-project overrides) can wait for a second version.

Two rules for the entry, both from TypeSafe's own docs:

- **Pin `jev-1.13.0`, not `jev-latest`.** An alias moves when they ship, and thresholds tuned against
  one version's distributions are not portable to the next. The response carries the versioned id
  that answered; write it into the journal detail of every finding so a threshold change can be
  argued from evidence.
- **Keep every question and threshold in one file** (`questions.ts` in the extension). This is
  TypeSafe's own advice for reviewability and it happens to be Tade's: a setting Tade accepts and
  ignores is worse than one it does not have, and a rubric scattered across call sites is the same
  failure wearing a different hat.

---

## 3. Ask and grep: the two tools everything else is built on

Two tools, and a third that reads what they did. **Everything else in this document is one of these
two pointed at something specific** — which is why there is no section about the Sentry extension
any more. Triaging issues is `jev_ask` with the issues as the state. Reading logs is `jev_grep` over
what `sentry_events` already returns. A tool per source is a tool per source forever, and it drags
one extension's credentials into another's code for nothing.

### `jev_ask`

```ts
jev_ask({
  state: string | object,   // what to judge: text, or records as JSON
  questions: Array<{ id, kind: 'yes-no'|'pick'|'rate', ask: string, options?, levels? }>,
}) : ToolAnswer             // one answer per question: probability, or the pick/level with confidence
for: ['orchestrator', 'agent']
```

The whole model in one tool. Give it a diff, an issue list, a paragraph someone pasted, a config
file, the output of another tool, and ask up to a few dozen bounded questions about it at once.

Throws when: `questions` is empty; two questions share an `id`; a `pick` has fewer than two options
or more than 255 (Jev's cardinality limit); a `rate` has fewer than two levels; the state is over
budget, naming how much to cut. Its description carries the warning that matters most: this model
answers the question **as written**, cannot count, cannot do arithmetic, cannot compare dates, and
will be steered by text that argues with it — so keep the maths in code and the questions literal.

### `jev_grep`

```ts
jev_grep({
  question: string,                                   // in plain words, not a pattern
  source: 'text'|'journal'|'transcript'|'lane'|'file',
  text?: string,                                      // when the source is text: paste it in
  task?: string, lane?: string, file?: string,
  period?: string, limit?: number,                    // rows to read; 200 unless said
  keep?: number,                                      // probability to keep a row; 0.6 unless said
}) : ToolAnswer                                       // the lines that matched, likeliest first
for: ['orchestrator', 'agent']
```

Grep that reads. It chunks the lines into batches that fit the state budget and asks **one yes/no
question per line** in a single request per batch — all evaluated in parallel against the shared
state, which is what makes it affordable: 200 lines of log is around 3k tokens, roughly **$0.0001 a
batch**. Then the sorting and the cutoff happen in code.

`text` is the important source and the reason there is no Sentry tool: whatever another tool just
returned can be piped straight in. `journal` reads `events.jsonl` through `readJournal` (no window
needed); `transcript` reads an agent's pi session; `lane` reads scrollback; `file` reads a file in a
project Tade knows.

Throws when: `question` is empty; `source` is not one of the five; `text` is missing for `text`, or a
named task, lane or file does not exist; a path is outside every known project (never read an
arbitrary path because a model asked); the key is missing or TypeSafe answers 401/422/429/529. It
does **not** throw on nothing found — that is an answer, and often the useful one.

### `jev_findings`

```ts
jev_findings({ project?: string, since?: string, task?: string }) : ToolAnswer
for: ['orchestrator', 'agent']
```

What the watch has looked at, what it flagged, and what came of it — read out of the journal and the
review log. **It asks Jev nothing**: no network, no key, instant, works with the window closed.
Section 5 is what it renders and why that record has to exist. Throws only on an unknown project or
task; an empty list is an answer.

### Triage with no triage tool

What `sentry_triage` would have been, done in the conversation instead:

1. The orchestrator calls `sentry_issues` — which already exists — for the last day's unresolved
   issues.
2. It calls `jev_ask` with those issues as the state and a handful of questions: *does the stack
   trace point at our own code · could this be a security problem (four levels) · how badly is a
   person affected (four levels) · does this read like something that used to work · is there enough
   here to fix it without reproducing it first*.
3. It ranks them with a weighted sum it can show you, says which it would fix first and why, and
   hands the top one to `sentry_fix`, which already exists too.

No new Sentry code, no shared credentials, and the rubric is visible in the conversation where it can
be argued with rather than buried in an extension. The same three steps work on anything that comes
as a list: dependency advisories from `deps_check`, failing tests, a pile of CI logs, whatever
somebody pastes. The cost is that the orchestrator has to bring the questions, so its prompt carries
two or three worked rubrics as examples — cheaper to maintain than a tool per source.

### How each surface gets them

- **The orchestrator**: `orchestrator(ctx)` tells it when to reach for which — grep for "find me the
  lines that…", ask for "judge these against…", findings for "what did the review turn up" — and
  warns it never to treat a probability as a verdict.
- **pi agents**: both are `for: ['agent']`, so every agent is handed them by its harness through the
  `ToolHost` as its own tools, no agent-side setup. Alongside goes a pi skill (`harness.pi.skills`)
  with the jaggedness list in it: literal reading, no counting, no date maths, no explanations — so
  an agent writes questions that work and does not take 0.91 as gospel.
- **The window**: Ctrl+K, the status item and the brief, in section 6.

---

## 4. Watching what agents commit

### What changed, and why

The first draft of this section reviewed **every commit** on a fifteen-minute clock and turned each
finding into queued work. The arithmetic kills it: eight hazard questions over twenty commits a day
is 160 judgements, and at even a 2% false-fire rate that is three bogus findings a day — each one
costing somebody a diff read, because Jev cannot say why. Three a day is how a tool gets switched
off in a week. So three changes, and they are the whole difference between this working and not:

**The unit is a task's diff, not a commit.** `base...HEAD` of the task's branch, with the task's
`intent_spoken` in the state. Ten times fewer units, each one something a person actually cares
about, and it makes room for the question nobody else is asking: *does this change do what was
asked, and what else did it do?* A commit is a step; a task is a change.

**The moment is when a branch stops moving**, not when a clock ticks. A look is `git rev-parse` per
task branch — nothing at all when nothing moved. A branch whose head changed and has then been
still for ten minutes gets read; so does one whose task is done. That is where a review is worth
having, and it means an agent mid-flow is never reviewed twice while it types.

**Two stages: Jev picks what to look at, and something that can write says why.** Stage one is Jev
over the diff, cheap, everything. Stage two runs only on what clears the high threshold: one agent
turn that reads the flagged diff and either writes a paragraph saying what is wrong and fixes it, or
says "false positive" — and that verdict is recorded (section 5). This is the cascade pattern from
TypeSafe's own cookbook, and it is the answer to the thing that worried me most: **what reaches a
person is never a bare number, it is a sentence somebody wrote.**

### Is it a watch, an extension with tools, or a git hook?

**It is a watch, inside an extension that also has tools. It is not a git hook.**

*Not a git hook*, for four reasons, any one of which is enough:

1. A hook runs **as the agent, in the agent's process**, with the agent's environment. It would need
   the TypeSafe key in every agent's environment, and "nothing inherited is written to disk" exists
   because that is exactly the class of thing we do not spread around.
2. A hook can **block a commit**. An agent that cannot commit because a review service is rate
   limited is a worse failure than an unreviewed commit.
3. Hooks are **per-clone and not under version control**; in the `checkout` workspace every agent
   shares one `.git`, so one hook fires for everybody's commits with no way to say whose it was, and
   an agent editing the repo can remove it.
4. Tade already has a thing for "look on a clock, find work, never act on the same finding twice",
   and it is load-bearing. Writing a second mechanism next to it is how two sources of truth start.

*A watch*, because a watch is precisely this: a cheap look on a clock, findings with stable keys, and
what to tell an agent about each. The machinery we would otherwise have to write — turning it on,
the cursor, the seen-set, at most `most` per look, the queue, telling the orchestrator, saying it
once when it starts failing — already exists and is tested:

| What we need | What already does it |
|---|---|
| Turn it on, per project, with settings | `tade_schedule` → a `watch` schedule (`ExtensionWatch`, `host.watches()`) |
| Look every 10 minutes, and cost nothing when nothing moved | `Schedule.when` + `dueNow`; the window's `doLookWith` |
| Where the last look left off | `ctx.since` ← `watchedOf(id).since`, from `watch_checked` |
| One finding, one piece of work, ever | `watch_found` keys → `watchedFrom(...).seen` → `newFindings(found, seen, most)` |
| Don't start ten agents at 3am | `does.most` (default 2); the rest wait for the next look, which starts where this one did |
| Findings reach the orchestrator | `does.found: 'ask'` → `watchFound(id, finding, { told: 'orchestrator' })` + `foundMessage` |
| Or start work directly | `does.found: 'agent'` → `createTask(..., start: { after: [] })`, which the queue starts when there is room |
| A look that cannot look | `watchChecked(id, { problem })`, said once, not at every look |

*And tools*, because a watch is only the unattended path. The same questions asked on demand —
"review what this agent has just done", from the orchestrator or from an agent about its own work
before it says it is finished — is a tool call, and a tool call needs no dedup: somebody asked, and
answering twice is fine.

### Where findings live

**Nowhere of its own.** That is the point. The extension keeps no state; the journal is the record:

- `watch_checked` — how many the look found, which keys were new (`fresh`), how many are left for
  next time, and where the next look starts. Or `{ problem }` when it could not look.
- `watch_found` — one line per finding, the first time it is found, with the task it started or who
  was told or why it could not start. A key already in that set is never acted on again, including a
  start that failed (which is deliberate: retried every look, it would fail every look).

The **key** is what makes this work, so it has to be chosen carefully. With the task as the unit:

```
<task>:<question id>        e.g. fix-payout-retry:authz_removed
```

One task, one question, one piece of work — ever. Not the sha (which a rebase or an amend changes,
so the same problem would be raised again and again in a branch that is still being worked on); not
the question alone (the same class of problem in another task is genuinely new); not anything with a
file or a line in it (a reformat would make it look new).

The trade-off, stated: a question that fires early in a long task and again later, about different
code, is raised **once**. I think that is right — the second one lands in a review of the whole diff
that already mentions the first — and the review log keeps the later head, so nothing is lost. If it
turns out to matter, the key gains the base it was measured from and everything else stays as it is.

### What the look actually does

`check(ctx)` — no model in the harness sense, but it does call Jev, which is the judgement that
decides whether there is a finding at all. Bounded so it stays a *cheap look*:

1. **For each task branch in the project, `git rev-parse`** (through the existing `git()` helper in
   `packages/status`, which already runs detached with a timeout). Heads unchanged since the last
   look, and heads that moved in the last ten minutes, are left alone. **Usually this is where the
   look ends, and it has cost four milliseconds and no money.**
2. For a branch that is ready: `git diff <base>...<head>` with lockfiles, generated files and
   binaries dropped, split per file and truncated. The state is a JSON object — the task's
   `intent_spoken`, the branch, the files, the diff — not a blob of prose, because
   [State](https://docs.typesafe.ai/concepts/state) takes structure and jaggedness #5 punishes
   irrelevant bulk.
3. One request per file (or per few small files), every question in each. A file the questions
   cannot be about — a fixture, a lockfile that slipped through — is skipped in code, not asked
   about.
4. Combine in code: a question fires for the task if it clears `report` in any file, and the finding
   names the file with the highest probability. Title = the question's own words, the task, the
   file.
5. `since` = the heads reviewed, so the next look knows what has moved.

Budget, so this stays honest: the watch timeout is **60 seconds**, and the common look does no work
at all. A task of a dozen files is a dozen requests at a claimed 0.3–0.5s, comfortably inside both
the timeout and 1,200 requests/minute. Cost: a 500-line task diff is roughly 20,000 characters,
call it 5k tokens over a dozen requests → **about a tenth of a cent per task reviewed**; fifteen task
reviews a day is **under two cents**. Stage two is where the real money is — one agent turn per
confirmed finding — and it is capped by `most` (two per look by default), which is the number that
actually governs the bill. All of that is arithmetic on published prices, not a measurement.

### The questions

Two groups, both in one file, both plain enough to be read by whoever gets woken up.

**Security and correctness** (nouls, one per hazard — never one "is this safe?" question, because a
question hiding several judgments is the first thing their docs tell you not to write):

```
shell_injection    Does this change pass a value that came from outside the program into a shell
                   command, without escaping or an allow-list?
sql_injection      … into an SQL query as text rather than as a parameter?
secret_committed   Does this change add a password, API key, token or private key written out in
                   the code, rather than read from the environment?
authz_removed      Does this change remove or weaken a permission check on an existing operation?
path_traversal     Does this change build a filesystem path out of a value that came from outside?
unsafe_exec        Does this change run code that was built from data at runtime (eval, new Function)?
error_swallowed    Does this change catch an error and continue without reporting it anywhere?
test_missing       Does this change alter behaviour without adding or changing a test that covers
                   it?
did_what_was_asked (yes-no) Does this change do what the task said it would? The task's own words
                   are in the state, and this is the question no linter can ask.
severity           (score) How bad would it be to ship this as it stands?
                   ["nothing to say", "worth a comment", "fix before release", "must not ship"]
area               (choice) Which part of the system does this change? <the repo's own subsystems>
```

**This repository's own rules**, which are the interesting half, because `tsc` and Biome cannot
check them and a reviewer has to read for them. Tade's `AGENTS.md` is already a list of invariants
written as sentences; each becomes a noul nearly verbatim:

```
port_vocabulary    Does this change give a port interface a method or field named after one
                   implementation's vocabulary (sendKeys, tmux, pi) rather than what it does?
sniffed_capability Does this change branch on which implementation something is, instead of on a
                   capability it declares?
dead_setting       Does this change add a configuration key that nothing reads?
mocked_git         Does this change replace git in a test with a fake, instead of a real repository?
silent_failure     Does this change make something fail without the orchestrator being told in words?
kind_fixture       Does this change make a test fixture tidier than a real repository would be?
```

(The Biome plugin `no-port-id-check.grit` already catches the literal `driver.id === 'tmux'` form.
The noul catches the version written as a switch on a name three files away, which is the one that
gets through.)

### Raising it: a sentence somebody wrote, not a number

The human's ask — *"report to orchestrator that will keep running agents after they are done with
their current tasks"* — maps onto `found: 'ask'`, which stays the **default**. What is new is stage
two in the middle, so that nothing reaches a person as a bare probability:

1. The watch finds `fix-payout-retry:authz_removed` at 0.88.
2. `watchFound(..., { told: 'orchestrator' })` writes it down — so it is never found "for the first
   time" again — and the window tells the orchestrator, under the rule that Tade tells the
   orchestrator and never talks over it.
3. **Stage two.** For a finding over `act`, the orchestrator reads the flagged diff itself (or starts
   a short-lived agent for it) and comes back with one of two things: a paragraph saying what is
   wrong and what it would do, or "false positive, here is why". Either way it is written down
   (section 5). This costs one turn per confirmed finding and it is what buys the explanation Jev
   cannot give.
4. Only then does work get made, and only for what survived stage two. When the fix should wait for
   the agent that wrote the code, that is `tade_plan` with
   `after: [{ agent: '<that task>', why: 'it is still changing these files' }]`, and the queue does
   the waiting — by rule, on every look at the tasks, as far as `max_parallel` allows. In a shared
   checkout that wait is not politeness, it is the thing that stops two agents editing the same file.

**Raise in batches, never one at a time.** A task review that flags three things is one message with
three lines in it, not three interruptions; `most` caps what any single look acts on, and the rest
wait for the next look. Overnight, nothing is raised at all — it lands in the brief in the morning
as one line, with `ask` set to "tell me which are worth fixing", which is how the orchestrator gets
invited rather than barging in. Nothing here is ever `blocking`: a review finding is `notable` at
most, because nothing is running into a wall.

`found: 'agent'` (start work straight away) stays available for a project where reviews should never
wait, but note what it does today: work created by a watch is queued with `after: []`, so it is ready
immediately and starts as soon as there is room — it does **not** wait for the agent that wrote the
code. If we want watch-started work to wait on the task a finding came from, that is a change to
`Workbench.watchFound` (let a finding carry `after`), and it belongs in its own task with its own
tests. Until then, "wait for the current task" is the orchestrator's path, and that is another reason
for `found: 'ask'` to be the default.

### Tools (extension `jev`)

Names start with the extension's name, per the host's rule.

```ts
jev_review({
  project?: string,   // the Tade project; the one you are in when there is one
  task?: string,      // review this task's whole diff against its base — the watch's own unit
  ref?: string,       // or a commit or range, when you want exactly that; HEAD~1..HEAD unless said
  paths?: string[],   // only these files
  threshold?: number, // report at or above this probability; the setting unless said
}) : ToolAnswer        // a table: question, probability, confidence, file
for: ['orchestrator', 'agent']
```
Throws when: there is no TypeSafe key (`ready()` says so first, so the tool is not even offered);
the project is unknown or it has to be said which (`ctx.project()` throws that sentence already);
`ref` does not resolve in that repository; the diff is empty after filtering (says so rather than
returning a cheerful nothing); the state is over budget even after truncation, naming what to narrow;
TypeSafe answers 401/422/429/529, with the status and what to do. It does **not** throw on "found
nothing": that is an answer.

`jev_ask` and `jev_grep` (section 3) are the other half of the on-demand path: an agent can ask the
rubric of its own work before it says it is finished, and a person can ask something the rubric does
not cover without anyone editing a file.

And the watch:

```ts
watches: [{
  id: 'review', title: 'Review what agents change', every: '10m',
  means: 'When an agent’s branch stops moving, reads its whole diff with Jev — security,
          correctness, and this repository’s own rules — then has what it flags read by
          something that can explain it, and reports that.',
  input: { threshold?: number, questions?: string[], settle?: string,
           include?: string[], exclude?: string[] },
}]
```

### Three things to get right, or don't ship it

- **A diff is attacker-controlled text.** Jev's own jaggedness list says state is not treated as
  hostile: a comment in a patch that argues for its own safety can move the answer. Therefore a Jev
  answer may only ever **add** work, never remove or shorten review, never approve, never close
  anything. The loop is allowed to be wrong in the direction of nagging.
- **Never let it gate a commit or a merge.** It has no veto anywhere. It produces findings; people and
  the orchestrator decide.
- **Record the answering model version with every finding** (the response's `model` field). The first
  time thresholds drift after a TypeSafe release, that field is the whole investigation.

---

## 5. The record: what looked, what it found, and what came of it

Three questions. As the design stands so far, Tade answers one and a half of them:

| Question | Answered by | Today |
|---|---|---|
| What did the watch do? | `watch_checked` | yes — how many read, how many fired, how many new, where the next look starts, or why it could not look |
| What did it find? | `watch_found` | yes — one line per finding, the first time only, with the task it became or who was told |
| Was it right? | nothing | **no** |

The third is the one that decides whether running any of this was worth it, and an agent's parting
sentence does not answer it: after a month you would have "Jev made 140 findings" and no way to say
whether that was good. So the record is part of the build, not something bolted on when somebody
finally asks.

### What is derived, and what is kept

**Derived — never a second source of truth.** Looks, findings, what was raised, what became of it:
all of that is already in the journal plus git, and `jev_findings` works it out on demand, the way
status does. Which looks happened and what they cost, what fired, which finding became which task,
whether that task finished, and whether it committed anything touching the file that was flagged.

**Kept — because it cannot be derived.** One append-only file, `<home>/jev/reviews.jsonl`, one line
per review:

```json
{"at":"2026-09-18T02:14:09Z","project":"tade","task":"fix-payout-retry",
 "base":"8fc21ab","head":"41d0c7e","model":"jev-1.13.0","files":12,"cost_usd":0.0011,
 "answers":{"authz_removed":0.88,"test_missing":0.71,"shell_injection":0.04},
 "raised":["authz_removed"],
 "verdict":{"authz_removed":{"was":"confirmed","by":"orchestrator",
             "said":"the middleware check moved inside a branch that skips it for internal callers"}}}
```

Two things in there earn their keep:

- **Every answer, not only the ones that fired.** Keep just what cleared 0.6 and you can never ask
  what 0.75 would have done: every threshold change becomes an experiment to re-run instead of a
  question to re-ask. The whole vector is a few hundred bytes.
- **The model version.** The first time the answers drift after a TypeSafe release, that field is
  the entire investigation.

Honest about the invariant. *A watch keeps nothing itself* — and this file is **evidence, not
state**: delete it and the watch behaves identically, it just goes blind about itself. That is the
test I would apply to any file a watch wants to write, and this one passes it. Nothing in the loop
reads it to decide anything.

### The verdict, derived where it can be

Stage two produces the verdict in words, and words are what a person reads. What gets *counted*
should be derived, because a count of prose is not a count:

- the finding became a task, the task finished, and it committed a change touching the flagged file
  → **acted on**;
- the task finished having changed nothing, or its agent said plainly that it was wrong → **not a
  problem**;
- removed, held, or still going → **neither, yet**.

That is `task_done` plus git: no new event type, nobody having to remember to fill a form in, and
the same trick as everywhere else here — status is a query.

### What you can read

`jev_findings` renders it, the window's `view()` shows the same thing, and both come from one
function:

- **This week**: looked / read / fired / raised / acted on / not a problem, per project.
- **By question**: how often each fired, and how often it was right. This is the table that matters,
  because **the answer to a question that never fires truly is to delete the question.** A rubric
  nobody prunes becomes noise, and noise is how the loop dies.
- **Calibration**: probability bucket against how often it was acted on. Ten rows and a count.
  This is the number TypeSafe have not published; after a few hundred reviews we would have our own,
  for our own work, which is the only version that matters.
- **Recall, against history**: the one measurement that shows what it *misses*, and the only one that
  cannot come from running it forward. We have a free labelled set — commits that a revert followed,
  and commits whose fix carries `Fixes <SHORT-ID>`. Run the rubric over their parents and see whether
  it would have fired. Cheap, repeatable, and the honest answer to "what is it not catching".

In the morning it is one line in the brief — "Jev read 6 task diffs overnight and flagged 2" — with
`ask` set to "tell me which are worth fixing". The record in the place people already look, and an
invitation rather than an interruption.

Optionally, and off unless asked for: the same digest written into the project as
`.tade/reviews/<week>.md` and committed as Tade, the way everything Tade writes for itself is
under git. That is for a team that wants the review history to travel with the repository and be
arguable in a pull request. It is a copy of a derived thing, so it is a convenience, never the
source.

---

## 6. In the window: Ctrl+K, the status bar, and what you can say

Everything above is reachable by talking to the orchestrator. That is already most of the value and
needs no window work at all: once `jev_review` and `jev_grep` exist, "what did Jev flag in the last
hour" is a sentence. What follows is what the window adds, split into **what costs nothing** and
**what costs a port change** — because those are very different decisions.

### What Ctrl+K is today

Ctrl+K (`keys.search`, rebindable) opens Search: one box for an agent, a file in any agent's
worktree, a line inside one, a line in a terminal's scrollback, something to do, a project, a
setting. Three things about it decide everything below:

- **`searchResults` is pure and synchronous.** Nothing in it may call anything. Results that need
  work — files from `git ls-files`, lines from `git grep` — arrive in `sources` when they arrive,
  and the panel carries a `busy` flag while they do.
- **Matching is a fuzzy score over text, and `#` search is `git grep -F -i`: fixed strings, not
  patterns.** What you type is what you mean. Nothing in the box understands a question.
- **Extension actions are already in it.** The window's entry list loops over
  `extensions.actions()` and puts each one under ACTIONS, with the extension's title beside it and
  `>` to narrow to actions.

### Tier 1 — free today, no new extension points

Declare `actions` on the `jev` extension and they appear in Ctrl+K the moment it loads, as
`run:extension:jev:<id>`, and — with `heard` — as phrases you can say with no model in the way:

```ts
actions: [
  { id: 'review', title: 'Review the latest commits', tool: 'jev_review',
    input: { ref: 'HEAD~5..HEAD' }, project: true,
    heard: [/^(review|check) (the )?(last|latest) commits?$/i] },
  { id: 'flagged', title: 'What Jev flagged', tool: 'jev_findings', project: true,
    heard: [/^what did jev (find|flag)/i] },
]
```

`jev_findings` (sections 3 and 5) is the one worth putting in the box: it asks Jev nothing, costs
nothing, works with no key and no network, and answers "what did the overnight review turn up" —
which is the question people will actually ask, and the one thing here that must never make them
wait.

The rest of the window comes along for the ride, all of it already supported by the port:

| Surface | What it shows | What it costs us |
|---|---|---|
| Ctrl+K → ACTIONS | the two actions above | declaring them |
| Voice | the same, through `heard`, no model | one regex each, kept narrow |
| Status bar | `status()`: `jev · 41 read · 2 flagged · 0.7¢` | must be cheap and shared — cache the last look, never ask on the timer |
| Its `view()` | the markdown a click opens: the last look, what fired, at what probability, and what it cost | a function that renders the journal |
| Brief | `brief()`: "Jev flagged 3 things in last night's commits", with `ask` = "tell me which are worth fixing" | one function |
| The news line and transcript | `watch_found` already reaches both | nothing |
| GIT panel | a finding's `links` are kept on the task and shown there | nothing |
| Extensions panel | `setup()`: the guide that tells a person how to get the key (section 9) | one function |

**The one thing Tier 1 cannot do**, and it is the interesting one: an `ExtensionAction` carries a
*fixed* `input`. There is nowhere to type a question. So "ask Jev something about these logs" cannot
be an action — today it is a sentence to the orchestrator, which calls `jev_grep` with what you
said. That is not a bad answer; it is just not Ctrl+K.

### Tier 2 — `?` in the search box: asking instead of matching

The obvious next move, and the one to be careful about. Search has scopes: `@` agents, `#` in files,
`>` actions. Add `?`:

```
?  which of these tests touch the queue when a task is removed
```

Same candidates search already has in hand — file names, the lines `git grep` found, terminal
scrollback, agent names — but ranked by whether they **answer the question** rather than whether they
contain the letters. One request, one yes/no question per candidate, all evaluated in parallel
against one state: around 200 candidates per request (Jev's option cardinality is 255, and the state
budget binds first), roughly **$0.0001 an ask**, a few hundred milliseconds. This is the single
surface where Jev's shape is most obviously right: `git grep` cannot do it, and a frontier model is
far too slow to put behind a text box.

What it would take, concretely:

| Where | What changes |
|---|---|
| `packages/app/src/search.ts` | a `SearchKind` for answered results, a `GROUPS` entry, a `SCOPES` entry for `?`. Still pure: the answers arrive in `sources`, like `matches` do. |
| `packages/app/src/panels.ts` | the search panel keeps the asked query and its `busy` state |
| `packages/app/src/app.ts` | gather candidates, ask, carry out the choice |
| the extension port | **new surface**: something an extension offers that ranks candidates for a query |

And the rules it has to obey, none of which are negotiable:

- **Never ask per keystroke.** `#` already waits for three characters before it greps; `?` waits for
  Enter, or a clear pause. 70–500ms per call times every keystroke is a slow box and a pointless
  bill.
- **Never block a frame, never empty the box.** An ask that fails — rate limited, offline, no key —
  leaves the ordinary fuzzy results exactly as they are and adds a quiet note saying why. A search
  box that throws is worse than one that never learned to answer questions.
- **The window must not know TypeSafe exists.** The app asks *an extension*; the extension asks a
  judge; the judge happens to be Jev. Anything else drags a vendor's name into `app.ts`.
- **Offered only when something can answer it** — a declared capability, checked the way the window
  checks every other one, never `extension.name === 'jev'`. With no key, `?` is simply not a scope,
  and the chips under the box do not offer it.
- **It is a new extension point, so the conformance suite comes first** (R4), and the port's
  vocabulary is "rank these candidates against this question", not anything Jev-shaped (R2).
- **It is drawn every frame, so it gets a performance test** — the standing rule for anything on a
  timer or in the draw path.

**Recommendation: build Tier 1 with the extension, and hold Tier 2** until the review loop has run
for a few weeks. Not because it is hard — it is maybe two days — but because it is the one surface
in Tade that must never get slower or stranger, it adds a port, and the same question typed to the
orchestrator gets answered today with no new code at all. If Tier 2 does get built, it should be
because people were reaching for `?` and finding it missing, which is a thing we will be able to see.

---

## 7. Standalone tools, or in Tade?

### Recommendation

**Build it inside Tade, in three pieces, and publish nothing standalone yet.**

1. **`packages/judges/core`** — a port and its conformance suite. Not an extension: a subsystem, like
   drivers or voice, because more than one thing will judge and we will want to swap what does.
2. **`packages/judges/jev`** and **`packages/judges/scripted`** — the HTTP client, and a judge that
   answers from a table (what tests and `--safe` use; also the honest way to demo the loop with no
   key).
3. **One extension**, `jev`: `jev_ask`, `jev_grep`, `jev_findings`, `jev_review`, and the review
   watch. It takes a judge from the registry by name and never knows TypeSafe's URL. **No other
   extension changes** — Sentry keeps its own tools, and triaging its issues is `jev_ask` pointed at
   what they return.

Nothing else. No npm package, no MCP server, no separate CLI.

### Why that, against the four rules

**R1 — every port is an interface plus a registry.** The judge is a port: `Judge.ask(state, questions)`,
with `JUDGES` mapping `'jev' | 'scripted'` to implementations and call sites never constructing one.
The second implementation is not hypothetical — TypeSafe ship a Python adapter that answers the same
calls with OpenAI or Anthropic precisely so you can compare, and we will want the same thing the
first time someone asks "is Jev actually better here than Haiku?". A port also means the review loop
keeps working when the early-access key is not there yet.

**R2 — no port interface uses an implementation's vocabulary.** This is the rule with real teeth
here, because TypeSafe invented a word. The port says:

```ts
export type Question =
  | { id: string; kind: 'yes-no'; ask: string; means?: { yes: string; no: string } }
  | { id: string; kind: 'pick'; ask: string; options: Record<string, string | null> }
  | { id: string; kind: 'rate'; ask: string; levels: readonly string[] }

export type Answer =
  | { kind: 'yes-no'; probability: number }
  | { kind: 'pick'; picked: string; probabilities: Record<string, number>; confidence: number }
  | { kind: 'rate'; level: number; levels: Record<string, string>
      probabilities: Record<string, number>; confidence: number }
```

`noul`, `systemone`, `criteria` and `jev` appear in `judges/jev` and nowhere else. If a second
implementation would have to learn the word "noul" to satisfy the interface, the interface is wrong.

**R3 — capabilities are declared, never sniffed.** `judge.capabilities`: `confidence` (Jev gives one
on `pick` and `rate`, not on `yes-no` — call sites must branch on that, and the LLM-backed judge may
have none at all), `parallelQuestions`, `maxStateTokens` (so the chunker asks rather than hardcodes
32k), `optionsPerQuestion` (255 today). No `judge.id === 'jev'` anywhere; the Grit plugin fails lint
on it already.

**R4 — conformance suites come first.** Write `judges/core/conformance.ts` before either
implementation: every question gets an answer under its own id; no answer names an option that was
not declared; probabilities sum to 1 within epsilon; a question id is never invented; an over-budget
state is refused with a sentence rather than silently truncated; a rate-limit answer surfaces as a
retryable failure with its status; nothing throws on an empty result set. Then `scripted` passes it
offline, and `jev` passes it against a recorded transcript. Tests never reach the network, as
everywhere else here.

### Why not standalone, concretely

- **`tade extensions run` already is the standalone tool.** `tade extensions run jev_review
  --project shop --input '{"ref":"main..HEAD"}'` runs in any shell, in any CI, with no window open,
  and prints the answer. Anybody's loop can call that today. A separate CLI would be a second way to
  do the same thing, with its own flags to keep in step.
- **An MCP server is a daemon, and we removed the daemon.** "There is no server. The one socket left
  is the `ToolHost`: a channel from the window to its own child agents, undiscoverable and dead when
  the window closes." An MCP server holding a TypeSafe key, listening for whoever connects, is the
  exact thing that invariant is about. It also duplicates what the extension port already does: pi
  gets these as registered tools, and a harness that speaks MCP is served by the host, not by us
  writing a server.
- **Maintenance cost is the whole argument.** A published package means semver, a changelog, an issue
  tracker, a release step, and a promise — all made about an interface to a **three-day-old model in
  selective early access whose rate limits the vendor says can change without notice**. TypeSafe
  already ship MIT SDKs in TypeScript and Python and an agent skill for Claude Code and Codex; a thin
  wrapper around their SDK would add a maintenance burden and roughly no capability.
- **What is actually portable is not code.** It is the **questions and the thresholds** — the rubric.
  If people want this in their own loops, publish `packages/extensions/jev/questions.json` and a page
  of README under the MIT licence we already use: no runtime, no semver, no support. That is the
  artifact with the value in it, and it is the one thing a wrapper would have hidden.

**Revisit when** all three are true: the judge port has not changed shape in a couple of months; Jev
is out of early access with a versioned, documented API; and at least two people outside this project
have asked for it. Then extracting `@tade/judges` is a small job precisely because the conformance
suite is already the contract.

---

## 8. Other things the novelty unlocks, ranked

Ranked by how much of an edge **Jev specifically** gives over calling a general model — which is high
when the work is (a) high volume, (b) a bounded decision, (c) latency- or budget-bound, and (d)
better for having a number you can threshold. It collapses to nothing when the answer needs prose.

1. **Reading every change, from every agent, always** (section 4). The edge is not quality — a
   frontier model reviews better — it is that for a tenth of a cent a task you read 100% instead of
   sampling, and get a probability to route on: Jev decides what deserves a real reader, and a real
   reader says why. This is the one that changes what Tade can promise, and the one still to be
   proved.
2. **Turn-level supervision of agents.** Tade sees every turn, tool call and cost. A judgement on
   each one has to be sub-second and free or it cannot exist: *is this agent looping? did this turn
   end without saying anything? is this tool call destructive in a way the policy has not named? is
   this agent stuck waiting for an answer nobody will give?* Today `approvals` is a hand-written
   rule list and "a conversation that goes quiet is the worst failure it has" is watched by nothing.
   TypeSafe's own second-best eval workflow is exactly this shape (agent trace observability, 71.6%).
   Strong edge, and it is the use case the writeup singles out: the harness gets more important, not
   less.
3. **Log, trace and transcript grep** (section 3). A semantic filter over material nobody reads at
   all today, at $0.0001 per 200 lines. Frontier models can do it; nobody runs them over a million
   log lines. Strong edge, mostly on cost — and the safest of the lot, because a person is right
   there and a wrong line costs a glance. **Build this one first.**
4. **Triage of anything that arrives as a list** (section 3): Sentry issues, dependency advisories,
   failing tests, whatever got pasted. Ranking is forgiving — you read the top five anyway — so
   being wrong is cheap, but the volume is low enough that a frontier model is affordable too. The
   reason it is worth having is that it costs **no code at all**: `jev_ask` with the list as the
   state, and the rubric written in the conversation.
5. **Queue and plan safety.** Before `tade_plan` starts two agents in one checkout: *will these two
   change the same files?* Would run on every plan, must be fast, and a probability is genuinely the
   right output. Marked down because it needs indirection (a property of a plan of a repository) and
   indirection is on the jaggedness list.
6. **Voice intent routing.** Between the narrow `heard` regexes and a full orchestrator turn there is
   a gap: "did they mean the thing the extension does, or are they talking to me?" At 100ms with a
   confidence to route on — act, confirm, or hand to the orchestrator — that gap closes. Edge is
   mostly latency; the risk is that misrouting a person's words is the most annoying failure Tade
   has, so thresholds would need to be high and the fallback always the orchestrator.
7. **What goes in the brief, and what interrupts.** Which of the night's events a person actually
   wants said out loud. Low volume, so a general model is affordable; the edge is that a calibrated
   score makes "say it / keep it / drop it" a threshold rather than a prompt.
8. **Telemetry shaping.** "Does this string look like a credential?" as a second pass behind the
   allow-list in `telemetry/shape.ts`. Small volume, high stakes, and regexes already do most of it —
   but a reporter must never block, and a 200ms check can run where a model turn could not. Modest
   edge, real value.
9. **Reflection and skill-worthiness** — "did this finished task teach a lesson?" One call per task,
   and the lesson itself has to be *written*, which Jev cannot do. Little edge.
10. **Anything that needs prose**: writing the fix, summarising the day, explaining a finding. **No
    edge — Jev cannot do it at all.** Their own docs: "If you really need to generate text… there are
    other models for that."

Products beyond Tade, if we ever wanted them, in the same order of edge: a CI review gate built on
the same question pack (every PR, every push, cents a month); a "question your logs" CLI; a
supervisor sidecar for other people's agent harnesses. All three are section-7 decisions, and my
recommendation there is to defer all of them until the rubric has proven itself on our own commits.

**What happened to this list in the 2026-09-19 revision.** Four of its entries turned out to be
bigger than a line and now have sections of their own: #2 turn-level supervision is §14.1, #5 queue
and plan safety split into §12 (whether two agents may run at once) and §13 (what the queue does
next), #6 voice intent routing is §14.5, #7 what goes in the brief is §14.4. #8 telemetry shaping
is withdrawn, and §15 says why. What is new and was not on this list at all is §11: the
orchestrator's own reading of what you asked for, which is the one place where being wrong is
expensive and nothing measures it today.

---

## 9. Getting a key

Jev is in **selective early access**: there is a console you can log in to and a waitlist, and I
could not verify from outside which one you land in. Checked 2026-09-18; all of it may have loosened
since, because they say they are letting people in as fast as they can.

**1. Ask for access.** Three doors, and they are worth going through together:

- **The console:** <https://console.typesafe.ai/login> — "Continue with Google", or an emailed code.
  This is the front door and it may be all you need.
- **The waitlist:** the *Join Waitlist* button on <https://typesafe.ai>. Their launch post asks
  people to say **which decisions they want to automate** — so say it: "reviewing every commit our
  coding agents make, and triaging error-tracker issues and logs, in an agent control room". That is
  close to two of their own four eval workflows (security incident response, agent-trace
  observability), which is the most interesting thing you can tell them.
- **Discord** (<https://discord.gg/typesafe>) is where access and jaggedness questions get answered
  fastest; `hello@typesafe.ai` for anything else, `sales@typesafe.ai` for higher rate limits,
  enterprise terms or zero data retention.

**2. Try it before you have a key of your own.** The Playground
(<https://console.typesafe.ai/playground>) runs a state and a set of questions in the browser once
you are logged in. Paste a real diff from this repository in as the state and one of the questions
from section 4 — five minutes there tells you more about whether this works than the rest of this
document.

**3. Create the key.** <https://console.typesafe.ai/settings/keys> (their docs also link
`/keys`, which redirects). One key per machine, so one can be revoked without stopping the others.

**4. Put it in the environment, never in a file.** Same rule as the Sentry token: Tade reads it
from the environment and never keeps a copy, nothing inherited is written to disk, and a lane's
saved spec holds only what Tade set.

```sh
# in ~/.zshrc (or wherever your shell reads), then start Tade from a new terminal
export TYPESAFE_API_KEY="…the key the console gave you…"
```

The extension reads `$TYPESAFE_API_KEY` unless `extensions.jev.key_env` names another variable, and
until it finds one `ready()` says exactly that sentence in the Extensions panel rather than failing
anywhere else.

**5. Check it before wiring anything to it.** Two commands, no Tade involved:

```sh
curl -s https://api.typesafe.ai/v1/models -H "Authorization: Bearer $TYPESAFE_API_KEY"

curl -s https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" -H 'content-type: application/json' \
  -d '{"state":"the payout job retries forever when Stripe returns 429",
       "model":"jev-1.13.0",
       "questions":{"bug":{"type":"noul","instructions":"Does this describe a bug that will keep happening until someone changes the code?"}}}'
```

What the answers mean: `401` the key is missing or wrong · `422` the question or state was malformed,
and the body names the field · `429` over the rate limit (250k tokens/sec, 1,200 requests/min, and
they warn these move) · `529` they are overloaded — back off and retry, do not hammer it.

**6. Know what leaves the machine before you turn the watch on.** This is the part to decide with
your eyes open: **the review loop sends your diffs to a third party.** TypeSafe say on their Models
page that Jev is not trained on customer requests or responses, and offer zero data retention to
enterprise customers — I have not seen those terms. For a repository where that is not acceptable,
the loop still works: point the judge at the LLM-backed or scripted implementation (section 7), or
run the watch only on projects where it is fine. The setting that decides it should be per project,
and nothing should be sending diffs anywhere the first time Tade starts — a watch is off until
somebody turns it on, which is exactly the right default here.

**7. Spending.** At $0.042 per million input tokens with output free, the whole 200-commit experiment
in the appendix is about fifteen cents, and a busy day of reviewing every commit is well under a
dollar. `extensions.jev.budget` caps requests per look so a repository import or a rebase storm
cannot turn into a bill you find out about later.

---

## 10. Where it may advise, and where it may not decide

Everything from here on puts Jev next to a decision that is already being made by something else.
So before any of it: **who decides now, what Jev is allowed to add, and what happens with no key.**

| The decision | Who makes it today | What Jev may do | What it may never do | With no key |
|---|---|---|---|---|
| What a request means | the orchestrator, a model, in words | answer a rubric about it, as a tool it calls or a reading appended under the person's words | record the intent, choose the route, or hold up the turn | §11 is off; the prompt rules, as today |
| Whether two agents may run at once | the orchestrator's `touches` + `checkPlan`'s pure `overlaps()` | say which pairs it thinks collide, and why | refuse a plan, insert a wait, start anything | §12 is off; path overlaps only |
| What starts next out of the queue | the window, by rule: `readyToStart` over written facts | propose an order, with a reason per item | write that order itself, or be consulted while the queue is being looked at | §13's order is whatever a person wrote, else arrival order |
| Whether a tool call is held | `decideApproval`, pure, regex tiers | turn an `auto` allow into an `ask` | turn an `ask` into an allow, or lower any tier | §14.2 is off; the rules as written |
| Whether an agent is stuck | nobody | tell the orchestrator, once | stop, prompt, restart or unstick an agent | §14.1 is off; nothing watches |
| What a diff contains | nobody reads them all | flag one for a reader | approve, close, or gate a commit or a merge | §4 is off |
| Whether a task is finished | its `done` rule, its agent, a person | nothing | anything | unchanged |
| What is true right now | `deriveState`, git, the driver | nothing | anything | unchanged |

Five rules hold that table together. They are the whole of the design; everything in §11–§14 is an
application of them.

**1. A judgement is written down before it is acted on.** Nothing changes what Tade does by being
believed. It changes what Tade does by becoming a fact somebody can read later — a journal line, a
field in a task file, a sentence in the transcript — put there by an act with an author on it. This
is what keeps "status is a query" true: the queue's look, `deriveState`, the state machine and the
index read written facts and never ask anybody anything.

**2. The rule stays where it is, and stays pure.** `deriveState`, `runtimeFrom`, `queueStateOf`,
`readyToStart`, `checkPlan`, `decideApproval`, `composePrompt`, `composeAgentPrompt`, `speakable`,
`dueNow` — facts in, answers out, no I/O, no clock. A judge inside any of them ends the property
that makes Tade explainable, and no amount of usefulness buys that back. Jev runs **before** them
and changes only *what facts they are handed*: a selection, a rank, an extra warning. Never what
they do with them.

**3. It may only add caution, never remove it.** It may raise a tier, add a wait, add a finding,
delay a start, ask for a person. It may never approve, allow, merge, close, unhold, resume, shorten
a review or skip a check. This is not squeamishness: a diff, a log line and a pasted paragraph are
text somebody else wrote, TypeSafe's own jaggedness list says Jev does not treat state as hostile,
and an integration that can only nag has a worst case of being annoying.

**4. A tool that would change a project starts an agent.** `jev_ask`, `jev_grep`, `jev_findings`,
`jev_review`, `jev_read_request`, `jev_plan_check` and `jev_queue_order` all read and answer; none
of them writes to a repository. The moment something should be *fixed*, that is an agent — the
watch's stage two (§4), or `ctx.tade.startAgent` with what was found in `.tade/context.md`, in the
project's checkout or a worktree as the person has Tade set up. A judge never edits.

**5. The no-key path is today's behaviour, and it is the tested one.** Every piece below degrades
to exactly what Tade does now — not to a worse version of it, not to a stub that answers 0.5.
`ready()` says the key is missing (no network, ever, on that path), the tools are not offered, the
advisory paths are skipped, and every existing test passes untouched. If a change would make the
no-key path worse than it is today, it is the wrong change. §16 lists what proves this.

And one rule about time: **nothing a person is waiting for waits for Jev.** Where an advisory call
sits on a path with somebody at the other end — the message going to the orchestrator, an approval
holding an agent — it gets a deadline (`extensions.jev.deadline`, 400ms) and a failure is not an
error, it is today's behaviour arriving on time.

---

## 11. In the orchestrator's own reasoning

### What it decides now, and how it goes wrong

Every request lands on a model with a prompt (`composePrompt` in `packages/core/src/compose.ts`)
whose `RULES` are, read closely, already a rubric:

- is this a question about what is happening (`tade_status`), or work?
- could it mean more than one task — and if so, ask which, never guess between two;
- is anything missing that has to be asked **before** starting, not after?
- is this several changes at once (`tade_plan`), one change (`tade_run_start`), something on a clock
  (`tade_schedule`), or something to watch?
- is this about an agent already running?
- is this a setting, which the orchestrator cannot change and should name the command for?

Those are six bounded judgements written as hopes. When one goes wrong it goes wrong *silently*:
a request that meant two tasks becomes one agent doing half of it, a question about state becomes a
new task, an ambiguity gets guessed instead of asked. Nobody sees the branch being taken — there is
no artefact, so there is nothing to argue with and nothing to measure.

This is the deepest place Jev fits, and the least obvious: not because it judges better than the
orchestrator's model (it does not), but because it judges **the same thing twice, independently,
for a hundredth of a cent**, and a disagreement between two readings is exactly the signal that
somebody should be asked.

### The rubric

One state — what they said, plus what the machine already knows: the projects, which agents are
running and on what, what is queued, and the last few things said. One request, all questions in
parallel:

```
shape        (pick)  what is being asked for
               question    — about what is happening; status answers it
               one_change  — one piece of work for one agent
               several     — several pieces that want a plan
               steer       — about work already going: it belongs to that agent
               recurring   — something on a clock, or something to watch for
               setting     — about how Tade is set up; say which command does it
               chat        — nothing to start
ambiguous_project   Could this be about more than one of the projects on this machine?
ambiguous_work      Could this reasonably mean two different pieces of work?
needs_decision      Does doing this require a choice only the person can make?
underspecified      Is something needed to start missing from what they said?
refers_to_running   Does this refer to work an agent is already doing?
wants_now           Do they want this started now, rather than planned for later?
wants_them_present  Would they need to be at the keyboard while this runs?
irreversible        Would doing what this asks destroy something that cannot be got back?
```

Nothing in there asks Jev to count, to compare dates, or to judge a property of a property — the
three things its own docs say it is bad at. Every question is about the words in front of it.

### Two shapes, and build them in this order

**(a) A tool the orchestrator calls: `jev_read_request`.** `for: ['orchestrator']`, state is the
request and the context, answer is the table above. Costs nothing on the turns where it is not
called, is visible in the transcript where a person can see it was consulted, and needs no change to
any existing code — it is one more extension tool. This is the whole of the first version.

Its weakness is the interesting one: **the orchestrator asks for a second opinion when it already
suspects it needs one**, and the failure we care about is the confident wrong branch, where it never
thinks to ask.

**(b) A reading appended to the message, before the orchestrator sees it.** The window already
composes what it sends: `withNews` in `packages/app/src/inbox.ts` puts what happened since the last
turn above the person's own words, under the heading `What they said:`, and `App.ask()` sends it.
A second block goes in the same place, under its own heading, below the words:

```
Since you last heard from Tade:
- 09:14 refunds finished

What they said:
fix the retry thing and also get the docs off the front page

A cheap reading of that, for what it is worth (a classifier, no explanation, often wrong —
the words above are what counts):
- it looks like two pieces of work rather than one (0.88)
- "the retry thing" could mean more than one task (0.71)
```

The rules on it, all of them load-bearing:

- **The person's words are never touched.** `intent_spoken` is stored verbatim and this block is not
  part of it; it sits under a heading that says what it is; it is never paraphrase, never above the
  words, never mixed in with them.
- **Only what cleared the threshold is included**, and the block is left out entirely when nothing
  did. A reading that lists every question with a number is noise, and noise in a prompt is how
  prompts stop being read.
- **It has a deadline** (`deadline`, 400ms). Past it, the message goes exactly as today. A model
  that cannot be reached must never be able to make Tade quiet — "a conversation that goes quiet is
  the worst failure it has".
- **It never runs on short utterances or on anything an extension's `heard` already matched.** "what
  is going on" does not need a classifier.
- **Off unless `advise` names `requests`.** With no key the block does not exist and `App.ask()` is
  byte-for-byte what it is now.

Keep the composition pure: a `withReading(message, reading)` beside `withNews`, testable with no
network, and the call to the judge in `ask()` where the other slow things already are.

### What it may never do

Choose the route; call a tool; create or name a task; record an intent; decide that something is
ambiguous and ask on the orchestrator's behalf; suppress, delay past the deadline, or rewrite a
turn. And it is never an explanation to a person: "Jev said 0.88" is not a reason, it is a number.
The orchestrator says what *it* thinks, in its own words, and may mention that something looked
ambiguous — which is what the person can argue with.

### The measurement nobody has to do by hand

This one labels itself, and cheaply. The journal keeps every line a person said (`said`, verbatim)
and what happened after it: `task_created`, `queue_started` for a plan, `schedule_changed`,
`run_started`, or nothing at all. The reading already said which `shape` it expected. Pair the two
and you have agreement per shape — `several` against a plan being queued, `one_change` against one
run started, `recurring` against a schedule, `chat` and `question` against nothing being made —
over a week, out of the journal, with no human labelling and no extra calls. The rows where they
disagreed are exactly the transcripts worth reading. That table is what decides whether shape (b)
stays on, and it can be computed before shape (b) is ever built: run the rubric over the `said`
lines already in the journal.

**In short.** *Does:* answers a fixed rubric about a request before the orchestrator commits to a
route. *Augments:* the `RULES` in `composePrompt`, which are hoped for rather than checked.
*Costs:* one request per turn it is used on (~$0.0001, 100–500ms behind a 400ms deadline); one new
tool; one pure function and one call site in the window. *Without a key:* no tool, no block, and the
orchestrator reasons exactly as it does today.

---

## 12. When to run agents at once, and when not

### What decides this today

`tade_plan` takes agents with `touches` — the files each will change, *as the orchestrator read the
code before anything started* — and `checkPlan` (`packages/core/src/queue.ts`, pure) settles the
order, refuses a plan whole when it cannot be kept (a cycle, a wait on something that does not
exist, `done: committed` in a shared checkout), and **warns** through `overlaps()` where two agents
that can run at the same time declare a shared path, including against work already going
(`PlanBusy`). It warns rather than refuses on purpose: "what an agent will touch is a reading of the
code, and the orchestrator may know better".

Three gaps, and all three are judgement rather than structure:

1. **`touches` is a guess made before the work starts**, by a model that read some of the code.
2. **Path equality is blunt.** Two agents can collide without sharing a file: a port and its
   implementation, a config key and the thing that reads it, a rename and everything that says the
   old name, a test fixture and the code that shape belongs to. In a shared checkout they also
   collide by leaving the gate red for each other.
3. **Nothing asks whether two pieces of work are two pieces of work**, or one job split in half so
   that neither half passes its tests alone.

### `jev_plan_check`

`for: ['orchestrator']`. Takes the same shape `tade_plan` takes — because the orchestrator has
already written it — and answers before the plan is kept. Per pair of agents that could run at the
same time:

```
same_files      Would these two changes end up editing the same file?
same_behaviour  Would these two changes have to agree with each other about how something
                behaves for both of them to be right? (an interface and what implements it,
                a setting and what reads it, a name and everywhere it is used)
one_job         Are these two really one piece of work that has been split in two?
b_needs_a       Does the second need the first to be finished before it can be done at all?
b_reviews_a     Is the second only worth doing if the first turns out a particular way?
```

And per agent:

```
too_big         Is this more than one agent's work as it is described?
needs_person    Would someone have to be at the keyboard while this runs?
gate_splits     Would this change leave the project's own checks failing until some other
                change lands?
```

`gate_splits` is the shared-checkout question. When everyone works in one tree, an agent that lands
a half-change does not inconvenience itself, it stops everybody — and no path comparison can see it
coming.

The state is the two agents' own words, their prompts, their declared `touches`, and — gathered in
code, not asked about — the project's top-level layout and what `git ls-files` says lives under each
declared path. Truncated, structured, no prose blob: irrelevant bulk costs accuracy, not just money.

**What it may not do.** Refuse a plan: `checkPlan` refuses, for structural reasons, and stays pure
and untouched. Insert a wait: the orchestrator writes `after: [{ agent, why }]` with the `why` in
its own words, because the queue shows every reason to the person and "Jev said so" is not one.
Start anything. And it is never called by the window — `queue/plan` must not depend on a third party
being up.

**Cost.** One request per pair, issued in parallel: five agents is ten pairs, a few hundred
milliseconds and about a thousandth of a cent, comfortably inside the rate limit. Capped at fifteen
pairs — above that the plan is too big to reason about, and saying *that* is the useful answer.
Asking one request about the whole plan with a noul per pair would be cheaper and is the wrong
shape: "a property of a pair inside a plan" is the indirection their own jaggedness list warns about.

**The related gap it does not fix.** Work a watch starts is queued with `after: []` and so begins as
soon as there is room, even if the agent whose code it is about is still typing (§4 says so). Jev
can advise *which* task a finding should wait on, but the waiting itself needs `Workbench.watchFound`
to let a finding carry `after`. That is its own task with its own tests, and it should be built with
or without Jev.

**In short.** *Does:* reads a plan before it is kept and says which agents would collide, which is
one job in two, and what would leave the gate red. *Augments:* `overlaps()`, which compares declared
paths. *Costs:* one request per pair, one tool, no change to core. *Without a key:* not offered; the
orchestrator plans from `touches` and the same warnings it gets today.

---

## 13. Ordering the work queue

### What order means today

`live.queued` is oldest first — arrival order — and `readyToStart` walks that list, starting each
item whose `queueStateOf` says `ready` as far as each project's `max_parallel` leaves room. So
order only matters when room is scarce, and then it is whichever was asked for first. Waits are
constraints, not preferences: there is no way to say "these three are all ready, do the broken one
first" except by starting it by hand.

Two things follow, and they should be built in this order:

### First, the mechanism — which is worth having with no Jev at all

**An order is a written fact.** `QUEUE_CHANGES` gains `order`; `tade_queue_change` takes a list of
task ids; the window's queue menu offers "Do this one first". It is written like every other choice
about the queue — a `queue_changed` line with the list, who asked, and why — and read back by a
pure function beside the others in `packages/core/src/queue.ts`:

```ts
/** Ready work in the order last written for it; anything unnamed keeps its place behind. */
export function inWrittenOrder(items: readonly Queued[], events: readonly TadeEvent[]): Queued[]
```

`readyToStart` keeps its signature and its rule: the window sorts what it passes in. Which means
nothing about *when* work starts changes — the same facts, the same answer, every time, no model
anywhere near `advanceQueue`, and the whole thing testable with a fixture of events. The addition
is additive in the literal sense too: `choicesFor` and `holdSaid` switch on the changes they know
and ignore anything else, so a journal with `order` lines in it reads identically to the queue as
it stands today.

The constraints on a written order, all of them the same constraint said five ways: **it is a
preference among work that is already ready.** It can never jump a wait, unhold a hold, resume a
pause, exceed `max_parallel`, or change what `queueStateOf` says about anything. It cannot starve
anything either, because it is a list somebody wrote and not a score that re-computes: the last line
written wins, and until another is written the order stands. The window's queue tree draws `next` as
the front of the resolved tree, so a new order changes what it calls next, which is exactly what the
person who reordered it expects to see.

### Then, the adviser

`jev_queue_order` — `for: ['orchestrator']` — answers "what should come first, and why" for what is
queued in a project. Two halves, and the split is the point:

**Derived in code, never asked:** how many pieces of work wait on this one (the graph is known), how
long it has waited, whether what it waited on just landed, whether its agent already has a
conversation to come back to, whether its base has moved under it, what it costs to run. All
arithmetic. Jev cannot count and must not be asked to.

**Asked, because it cannot be derived:**

```
broken_now       Does this fix something that is broken for someone right now?
unblocks_person  Is the person waiting on this before they can do anything else?
quick            Does this read like a small change, finished in one sitting?
risky_together   Is this risky to run while the work that is already going is going?
needs_person     Would it need them awake and at the keyboard?
stale            Does this read like something another piece of work has already done?
```

One request for the whole queue — each item a question against one shared state — so it is a tenth
of a cent and half a second however long the queue is. The tool returns a suggested order, the
number behind each item, and the derived facts beside them, so the orchestrator can say to a person
*"I'd do the payout fix first: it's the only thing broken right now, and two things are waiting on
it"* — a sentence, from a number plus a count, which is the division of labour this whole document
is about.

Then the orchestrator writes the order with `tade_queue_change`, or says what it would do and lets
the person choose. Either way an order exists because somebody chose it, with a reason, in the
journal. Which of the two it should do is decided by consequence, not by confidence: an order
written while a project has room starts something within seconds, so the orchestrator writes one
when it was asked to sort the queue, and otherwise says what it would do and waits to be told.

**What it may never do.** Reorder on a timer. Be called from `advanceQueue`, `queueStateOf`, or any
look at the tasks. Write its own order. Reorder anything that is not ready. Be the reason given to a
person.

**In short.** *Does:* suggests an order for ready queued work, with a reason per item, on demand.
*Augments:* arrival order, which is the only order there is today. *Costs:* one request per ask; a
new `order` change verb across core, the workbench, the queue tool and the queue menu — about the
size of `pause`. *Without a key:* the written order still exists and a person or the orchestrator
writes it; with nothing written, arrival order, exactly as today.

---

## 14. Other deeper places, and what each costs

Same four lines each. Everything here is off unless named in `advise`.

### 14.1 An eye on turns that are going nowhere

The supervisor already sees every turn: `Workers` in `packages/workbench/src/workers.ts` receives
each signal, and `agentTurns` times each turn with its tools and its tokens. Nothing reads them for
meaning. Three failures nothing notices today: an agent looping (same tool, same arguments, same
failure, six times over), an agent that ended its turn with a question nobody will answer, and an
agent that ended a turn having said nothing at all — which AGENTS.md already calls the worst
failure there is, because it looks like thinking.

The counting is code — a pure function of the last N signals for that run, producing a short
summary — because Jev cannot count. Jev judges the summary, once per `turn_done`, on agents in a
watched project: *does this read like work that is not getting anywhere? did this turn end asking
the person something? does this claim to be finished without having run anything?*

Over the threshold, the orchestrator is **told**, once per run and not per turn, the way Tade tells
it anything — after its current turn (`whenBusy: 'queue'`), never talked over, and never as
`blocking`, because nothing is running into a wall. The orchestrator tells the person. Nothing
stops, prompts, restarts or unsticks an agent, and nothing touches a `done` rule: a task is
finished when the journal says so, and a probability never says so.

*Does:* watches agent turns for looping, silence and unanswerable questions. *Augments:* nothing —
this is unwatched today. *Costs:* one request per turn on watched agents, after the signal is
dispatched and never before it (~cents a day for four busy agents). *Without a key:* nothing
watches, as now.

### 14.2 Approvals: raising a tier, never lowering one

`decideApproval` stays exactly as it is, pure, first-match-wins. The only place a judge may stand is
behind an `auto` allow for a `bash` command that **matched no rule at all** — which is where the
gap is: `HARD_COMMANDS` and `SOFT_COMMANDS` are regexes over shapes we thought of, and
`node scripts/wipe.js`, `find . -delete` and `> important.yaml` are not among them. A short rubric
— deletes something that cannot be got back · writes outside the worktree · sends data somewhere ·
changes a database · stops something that was running — turns the allow into an ask, with the
question's own words as the reason the person reads.

It may never turn an `ask` into an allow, never lower a tier, never answer on the person's behalf.
Deadline 300ms; past it, or on any failure, the decision is today's. Off by default and per project,
because this one sits in front of a working agent.

*Does:* catches destructive commands the rule list does not name. *Augments:* `classifyToolCall`'s
regex tiers. *Costs:* one request per unmatched `bash` call, 300ms at worst on the agent's own path.
*Without a key:* the rules as written, which is what runs today.

### 14.3 Which notes and which lessons a prompt carries

`composeAgentPrompt` takes the fifteen newest notes in scope; `livingSkills` keeps lessons whose
subject has been touched lately. Both are proxies for relevance, and both fail the same way: the
note that mattered was written a month ago. One request can ask "does this note apply to work
described as *X*?" of two hundred notes at once, for a hundredth of a cent, and hand compose the
ones that apply.

The selection happens **before** compose, which stays pure and deterministic — a change in what Tade
believes about itself must remain a visible diff, not a shift in behaviour nobody can point at.

One risk worth naming: notes are the one thing Tade is *told* rather than derives, and a note
dropped by a wrong judgement is a rule the agent never hears. So the threshold runs the other way —
keep unless it is confidently irrelevant — and notes with no scope are always kept.

*Does:* picks the notes and lessons that apply to this task instead of the recent ones.
*Augments:* newest-fifteen and `livingSkills`. *Costs:* one request per agent start. *Without a
key:* newest-fifteen and `livingSkills`, as today.

### 14.4 The brief, and what is worth interrupting for

`composeBrief` plus each extension's `brief()` decides what you hear in the morning; `spokenSummary`
decides how much of an answer is read out. Jev can score each candidate line — *does the person need
to hear this now?* — and a threshold makes it said, on screen, or dropped. Low volume, so the edge
over a general model is small, and the failure is benign (a line you read instead of hear). It earns
its place because it is the thing that decides whether people keep listening, and a threshold you
can tune beats a paragraph of prompt you cannot.

Jev cannot write the sentence. Composition stays exactly where it is; only the choosing moves.

*Does:* ranks what the brief says out loud. *Augments:* a fixed composition. *Costs:* one request a
brief. *Without a key:* today's composition.

### 14.5 Voice: the gap between a `heard` regex and a whole turn

Between the narrow `heard` patterns — which need no model and must stay narrow — and a full
orchestrator turn there is a gap that is currently resolved by sending everything to the
orchestrator. Jev can pick among the actions that exist, plus "hand it to the orchestrator", in
about 100ms. Two rules: anything under the confidence goes to the orchestrator, which is today's
behaviour; and an action that *starts work* is confirmed out loud before it runs, never fired on a
probability. Misrouting somebody's words is the most annoying failure Tade has.

*Does:* routes a spoken phrase that no regex matched. *Augments:* `heard`, and the fall-through to
the orchestrator. *Costs:* one request per unmatched utterance; latency is the whole point.
*Without a key:* regexes, then the orchestrator, as today.

### 14.6 An agent's last look at its own diff

A pi skill plus `jev_review` on its own branch, so an agent reads its own change against the rubric
before it says it is finished. It is a tool call, so there is no dedup problem and no watch. It may
not block `tade_done` — the `done` rule is the task's — but "read your own diff before you say you
are done" is a good instruction that costs a tenth of a cent, and it catches the missing test before
a person does.

*Does:* gives an agent the rubric about its own work. *Augments:* nothing. *Costs:* one review per
task. *Without a key:* the instruction stands with nothing behind it, which is where it is now.

### 14.7 Triage of whatever arrives as a list

Unchanged from §3, and repeated here only because it belongs to the same family: Sentry issues,
dependency advisories, failing tests, several watch findings landing at once. `jev_ask` with the
list as the state and the rubric written in the conversation, ranked in code. No new tool, no new
code, and the rubric is where it can be argued with.

---

## 15. Where it would not help, and where it would hurt

Said plainly, because a list of places a thing fits is worthless without the places it does not.

- **Anything that has to be written.** The fix, the commit message, the task's name
  ([`naming.md`](naming.md)), the paragraph that explains a finding, the brief's sentences,
  `spokenSummary`, an agent's opening prompt. There is no string in the response. This is not a
  limitation to route around: stage two in §4 exists *because* of it.
- **Anything git, `tsc`, Biome or a test already answers exactly.** Never ask a model whether two
  branches will conflict — `git merge-tree` knows, deterministically, for free. Never ask whether a
  symbol is used when the compiler can say. Keep the question only where the deterministic version
  is a proxy rather than an answer (which is why `dead_setting` survives: a grep cannot see a key
  read through indirection, and a reviewer can).
- **Anything pure.** `deriveState`, `runtimeFrom`, `queueStateOf`, `readyToStart`, `checkPlan`,
  `dueNow`, `speakable`, the event index, the state machine. A judge inside a pure function is the
  end of "status is a query".
- **Anything counted, timed or added up.** Spend, budgets, runtimes, token arithmetic, "how many
  times did it do that", "is this older than a week". Their own jaggedness list: no counting, no
  arithmetic, no date comparison. Compute it and put the number in the state.
- **Parsing.** Provider transcripts, git porcelain, config files. They have grammars, and a parser
  that returns `null` on an unknown shape gives a guarantee no probability can.
- **Telemetry scrubbing** — withdrawn from §8's list. Sending a payload to a third party to ask
  whether it is safe to send to a third party has already sent it. The allow-list in
  `telemetry/shape.ts` stays the mechanism, a reporter must never block, and a window that crashed
  while reporting a crash is the failure we are avoiding. An offline audit of what `KEPT` would have
  let through is a one-off somebody can run by hand, with the person's say-so, and it is still a
  disclosure.
- **The mute key, push-to-talk, and anything drawn every frame.** Mute is now. A judge is 70–500ms.
- **Deciding that a task is finished, or that a person's request is finished.** The `done` rule is
  the task's, and the person's satisfaction is theirs.
- **Anything where being wrong is invisible.** A filter that quietly drops a note, a log line, an
  issue or a brief item must be set to keep when unsure, and must leave a trace of what it dropped.
  Where you cannot see the false negatives, do not build the filter.
- **Anywhere the volume is low and a person is already reading.** A frontier model is affordable
  there, explains itself, and is 5–10 points better. Jev's edge is volume, and only volume.
- **As an explanation to anybody.** It has none. Whatever reaches a person is a sentence somebody or
  something that can write wrote.

---

## 16. Onboarding: the optional key, and life without it

§9 is how a person gets a key when they have gone looking. This is the one that matters: **the
minute they first run `tade setup`**, and the promise that saying "not now" costs them nothing.

### The principle

Tade works with no key. Not "works in a reduced mode" — works, exactly as it does today, on the path
that every test exercises. So the question is asked **once**, **last**, in one screen, skippable
with one key, and never asked again unless somebody goes looking for it in Settings.

### Where the step goes

`readiness()` (`packages/core/src/readiness.ts`) is a pure function from facts to an ordered list of
steps, and `tade setup` walks them. It gains one:

- **`StepId` gains `'judge'` — not `'jev'`.** Core must not learn a vendor's name (R2): a judge is a
  Tade concept with a port and a registry (§7), and Jev is one implementation of it. The title is
  **"A second opinion, if you want one"**.
- **`required: false`**, like `voice` and `talk`. `isReady()` is unchanged, so
  `tade setup --check` still exits 0 with this step undone, and nothing about it can ever stop
  somebody running an agent.
- **Last in the list**, after `talk`. It is the only step that costs money and the only one that
  sends anything anywhere; nobody should meet it before Tade works.
- **`ReadinessFacts` gains two flags**, in the shape of the ones that are already there
  (`driverChosen`, `talkChosen`): `judgeKey` — a key is in the environment — and `judgeChosen` —
  the person has answered, either way. `done` when either is true, so "not now" is a finished step
  and not a nag.
- **`judgeChosen` reads whatever records that an extension is on or off**, and does not invent a
  key of its own. If no such record exists when this is built, this step adds it rather than
  keeping a private one beside it — two places that say whether Jev is on is the bug this whole
  paragraph exists to avoid.

It dovetails with the wizard's coming extensions question (the queued `extensions-no-proposed` work
makes which extensions are on a wizard choice and a settings toggle): the judge step *is* that
question asked for one extension, with the key check attached. Whichever lands first, the other
reuses it; neither invents a second mechanism.

### What the screen says

The benefit has to be concrete, the cost has to be on the same screen, and the way out has to be one
key. Roughly:

```
A second opinion, if you want one

Tade can ask a small, fast model — Jev, from TypeSafe — bounded questions about
the things nobody has time to read: every diff your agents write, a thousand
lines of log, a plan before two agents start in the same checkout. It answers
with a number and no paragraph, in about a third of a second, for roughly a
hundredth of a cent a question.

With a key, Tade can:
  · read every change an agent makes, and tell you which ones want your eyes
  · search logs, transcripts and journals by meaning — "where did it give up?"
  · warn you before two agents that would collide start in one checkout
  · put a long queue in an order, and say why each thing is where it is
  · notice an agent going in circles, and say so

It never approves, merges or closes anything, and it never writes code: what it
flags, a person or an agent reads.

Without it, none of that runs and nothing else changes. You can turn it on any
time in Settings › Extensions › Jev.

Diffs and logs you point it at are sent to TypeSafe, who say they do not train
on them. Nothing is sent until you turn a watch on.

  [ set it up ]   [ not now ]
```

"Not now" writes the choice, marks the step done, and says one line: *skipped — Settings ›
Extensions › Jev whenever you want it.*

### What "set it up" does

1. **Says where a key comes from**, with the address shown rather than opened:
   `console.typesafe.ai/settings/keys`, and the waitlist door beside it for anyone who is not in yet
   (§9 has the detail, and the wizard should not repeat it).
2. **Looks in the environment** for `TYPESAFE_API_KEY`. Found: say where it was found, record that
   the extension is on, done. Recording is not loading: an extension is inert until it is turned
   on, there is no hot reload, and the wizard runs before the window — so what it wrote takes
   effect the next time Tade starts, which is the next thing that happens. Where turning one on is
   still a human moving a file, the wizard says the command and does not pretend otherwise.
3. **Never asks for the key to be typed into Tade.** Same rule as the Sentry token, for the same
   reason: a key typed into a wizard is a key in a file. It prints the line —
   `export TYPESAFE_API_KEY="…"` — says which shell profile it goes in, and that Tade has to be
   started from a new terminal. The step stays undone, blocks nothing, and `tade setup` again picks
   up where it left off.
4. **May check that the key works, here and only here.** One `GET /v1/models`, because a person is
   sitting in front of the screen having just asked for this. **This is exactly the thing `ready()`
   may never do** — `ready()` runs on every load, unasked, and touches no network; the port already
   draws this line for us, in `SetupField.choices(ctx)`, "values to offer, looked up when asked".
   Worth stating in the wizard's own comment, because it is the mistake a reader of this document is
   most likely to make.
5. **Turns nothing else on.** The tools become available; the review watch stays off until somebody
   turns it on with `tade_schedule`, per project. Nothing should send a diff anywhere the first time
   Tade starts.
6. **Offers the second-best option to anyone who says no to TypeSafe specifically:** if a provider
   key is already in the environment (the wizard already knows this list —
   `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), the LLM-backed judge (§7) answers the same questions
   with a model they already pay for. Honestly labelled: 100–400× the cost per question and seconds
   rather than milliseconds, so it is for the on-demand tools only and never for the per-turn or
   per-line paths, and nothing has calibrated it. A subscription login is not an API key, so for
   many people this option simply is not there — say so rather than offering it and failing later.

### Three judges, and which is the default

| Judge | When | Used for |
|---|---|---|
| `jev` | a TypeSafe key is in the environment | everything in this document |
| `llm` | a provider key is in the environment and the person chose it | the on-demand tools only; never per-turn, per-line or per-approval |
| `scripted` | tests, `--safe`, demos | answering from a table, offline |

**`scripted` is never a silent default in a real window.** A judge that always answers 0 is a review
that always passes, which is worse than no review at all. With no key configured, the extension is
simply not ready: `ready()` returns the one sentence, the tools are not offered, and the advisory
paths are skipped. Absent, not pretending.

### What runs with no key — every piece, spelled out

| Piece | With a key | With no key |
|---|---|---|
| `jev_ask`, `jev_grep`, `jev_review` (§3, §4) | offered to the orchestrator and to agents | not offered; `ready()` says why, in one sentence |
| `jev_findings` (§3) | reads the journal and the review log | **still works** — it asks Jev nothing and needs no key |
| the review watch (§4) | off until turned on, per project | cannot be turned on; the schedule tool says why |
| the review record (§5) | written per review | no reviews, no lines |
| Ctrl+K actions, status item, brief line (§6) | shown | the extension is not ready, so it contributes none of them |
| `?` in Ctrl+K (§6 tier 2) | a scope, if it is ever built | not a scope; the chips under the box do not offer it |
| reading a request (§11) | a tool, and a block under the person's words | no tool, no block, `App.ask()` unchanged |
| plan check (§12) | a tool called before `tade_plan` | not offered; `touches` and `overlaps()`, as today |
| queue order (§13) | a tool that suggests one | the written order still works; a person or the orchestrator writes it; else arrival order |
| turn watching (§14.1) | one call per turn on watched agents | nothing watches, as today |
| approvals (§14.2) | an `auto` allow may become an `ask` | `decideApproval` alone, unchanged |
| note and lesson selection (§14.3) | chosen by relevance | newest fifteen, and `livingSkills` |
| brief and voice (§14.4, §14.5) | ranked, routed | composed and fallen through, as today |

### What proves it

This is the part that makes the promise real rather than stated. Before any of §10–§14 ships:

- the extensions **conformance suite with no key**: `ready()` returns the sentence, no tool is
  offered, nothing throws, no network is touched on any path;
- `tade setup --check` **exits 0** with the judge step undone, and `readiness()` has a test per
  combination of the two new facts;
- the orchestrator's **golden tool list is unchanged** when no judge is configured: its own tools do
  not change shape because of an extension nobody turned on;
- the **queue tests as they are now pass untouched** — `readyToStart` with no written order is
  arrival order, and `queueStateOf` never learns a new state;
- `App.ask()` **appends nothing** with no judge, asserted on the exact message;
- **`--safe` loads none of it** and everything above still holds, including with a broken jev
  extension sitting in the extensions folder;
- and the whole suite still runs **offline, in under 30 seconds, with no network calls** — which is
  the invariant that would notice any of this creeping onto a hot path.

---

## What I could not verify

Everything in this section is a gap, not a claim:

- **Every number in section 2 is provider-reported.** Price, rate limits, latency and the eval
  results all come from TypeSafe. Nobody has run a single request from this repository yet.
  *(2026-09-19: access is no longer the blocker — there is a key. Which means every line in this
  section that says "until somebody measures it" is now something somebody can measure this
  afternoon, and step 4 of the appendix — the backtest — is no longer waiting on anybody.)*
- **Calibration is unproven.** RLCD is described but not published — no reward function, no training
  procedure, no calibration curves, no independently reproducible paper. The writeup makes the same
  point, and TypeSafe's own eval page does not measure calibration; it measures agreement with a
  consensus of GPT-6 Astra and Claude Fable 5.1. Calibration is the entire premise of thresholding on
  these probabilities, so until we measure it on our own commits, treat every threshold in here as a
  guess to be tuned against evidence.
- **The eval is theirs.** They designed the four workflows, wrote the harness, chose the reference
  models, and say themselves that design bias is possible and that the headline 193.6x/444.6x are
  "on the higher end of real-world gains". No independent benchmark of Jev exists that I could find
  three days after launch.
- **`confidence` is undocumented as a statistic.** They say it is derived from the distribution's
  shape and do not say which function. Anything we do with it beyond "higher is more concentrated"
  is unfounded; the raw `probabilities` are the safer thing to threshold on.
- **Provider coverage is a negative result with one hole.** OpenRouter I checked directly (445 models,
  no Jev). Together and Fireworks need an API key to enumerate, so for those I can only say I found
  no announcement or listing. No evidence of Bedrock or an Anthropic-hosted version either.
- **Two documented context numbers disagree** (64k vs ~32k, section 2). Measure before relying on
  either.
- **No SLA, uptime history or incident record** — it is three days old. A review loop that depends on
  it must degrade to "could not look" and say so, never to silence.
- **Whether an account gets a working key straight away.** Answered on 2026-09-19: this one did.
  Whether the next person's does is still theirs to find out, so section 9 keeps the waitlist door
  and section 16's wizard step must read sensibly for somebody who does not have a key and cannot
  get one today.
- **Not verified:** the ZDR terms beyond a mention on their Models page; whether `usage.input_tokens`
  is what you are billed for; whether the 1,200 rpm limit is per key or per account; how latency
  behaves as question count grows (they claim "barely changes" — the writeup asks for the same number
  to be measured by someone else, and so should we).
- **The cost arithmetic in section 4 is mine**, from their per-token price and my estimate of diff
  size. Nothing has measured a real diff.
- **The false-positive rate I argue from is invented.** "2% per question" is a number I chose to
  show the shape of the problem, not one anybody has measured. The whole case for reviewing a task
  rather than a commit rests on it, and the backtest in the appendix is what would replace it with
  something real.

And about sections 10–16, which are newer and therefore weaker:

- **Not one of the new rubrics has been run on anything.** The questions in §11, §12, §13 and §14
  are written from how Tade actually works, which makes them plausible and not correct. Each needs
  the same treatment §5 prescribes for the review pack: run it over history, compare with what
  happened, keep the questions that fire usefully and **delete the ones that never fire** — a rubric
  nobody prunes becomes noise, and noise is how the loop dies.
- **The 400ms deadline is a guess**, from their claimed 70–500ms. If the real p95 on our states is
  600ms, shape (b) in §11 is off the table and the tool stays, which is why the tool comes first.
- **Whether a reading *helps* the orchestrator is untested and could go either way.** A wrong
  reading appended to a request is a confident wrong hint, and a model that defers to it is worse
  than a model that read the words alone. The agreement measurement at the end of §11 exists to
  settle that, and it should run for a week with the block *off* before it is ever turned on.
- **The per-turn cost in §14.1 is arithmetic, not a measurement**, and it is the one that scales
  with how busy you are rather than with how much code you write.
- **Nothing has calibrated the LLM-backed judge** offered as a fallback in §16. It answers the same
  questions; whether its numbers mean the same thing at the same thresholds is unknown, and the
  thresholds are tuned per judge or not at all.

A first step that settles most of this cheaply, and is now the first thing in the appendix: take
200 commits out of this repository's history, run the question pack over them, and compare what it
flags against what code review actually caught. That is a day's work, it costs about 15 cents in
tokens, and it is the only thing that turns any of the above into a decision.

---

## Appendix: what to build first, in order

The order changed once the argument was written down. **Ask and grep come before the watch**: they
are useful the day they land, a wrong answer costs a glance rather than an agent run, and a fortnight
of using them tells you what the model is actually like before anything unattended is pointed at your
commits.

1. `packages/judges/core` — port + conformance suite + `JUDGES` registry, with `scripted` passing it.
   No network, no extension, nothing user-visible.
2. `packages/judges/jev` — the client, against a recorded transcript in tests.
3. `packages/extensions/jev` with **`jev_ask` and `jev_grep` only**, for the orchestrator and for
   agents, plus the pi skill that says how to write a question and what the model cannot do. This is
   the whole of section 3, it is a few hundred lines, and it is where triage-without-a-triage-tool
   comes from for free.
4. **The backtest, before any watch exists**: the rubric over 200 real commits from this repository's
   history, and over the parents of everything a revert or a `Fixes` commit followed. A table of what
   fired, what was true, and what it missed. About fifteen cents and an afternoon. **Go/no-go on that
   table** — and if the answer is no, everything above still stands on its own.
5. The review watch (section 4): task diffs, settle time, two stages, `found: 'ask'`, questions and
   thresholds in one file. A sketch is in
   [`extensions/proposed/jev/extension.ts`](../extensions/proposed/jev/extension.ts) — inert, as
   proposals are, and written against the first draft's per-commit shape, so read section 4 first.
6. The record (section 5): `reviews.jsonl`, the derived verdict, `jev_findings`, the tables. It goes
   in **with** the watch, not after it — a month of findings nobody can score is a month wasted.
7. Tier 1 of the window (section 6): two actions, a status item with its view, a brief line. All
   declaration, no new machinery, and it is what makes the loop visible to somebody who is not
   reading the journal.
8. `?` in Ctrl+K (section 6, Tier 2) — only if people are reaching for it. It adds an extension
   point, so: conformance suite, declared capability, performance test.

Then the deeper places, in an order chosen by two things: **the tools before the paths nobody
asked for**, because a tool is a few hundred lines and a path is a change to something that works;
and **the mechanism before the adviser**, because a written order and an escalated tier are worth
having with a person doing the judging.

9. **The three advisory tools**, in the extension, no core change between them:
   `jev_read_request` (§11a), `jev_plan_check` (§12), `jev_queue_order` (§13) —
   `for: ['orchestrator']`, read-only, each with its rubric in the same `questions.ts` as the rest.
   A fortnight of the orchestrator reaching for them tells you which rubrics survive.
10. **A written queue order** (§13's mechanism): `QUEUE_CHANGES` gains `order`, `inWrittenOrder`
    beside the other pure functions, `tade_queue_change` and the queue menu learn it. No Jev in it
    at all, tested with a fixture of events, useful on its own.
11. **The onboarding step** (§16): `StepId` gains `judge`, two facts, `required: false`, last in
    the list, plus the no-key tests listed there. It goes in here, not last, because it is what
    turns "there is an extension for it" into something a person is ever offered — and because
    writing the no-key tests before the advisory paths exist is what keeps them honest.
12. **Turn watching** (§14.1): the pure summary function first, with its tests, then the question,
    then telling the orchestrator once. The first thing that reads agent turns for meaning.
13. **The reading under the words** (§11b), only if the agreement table from step 9 says the rubric
    is right and the measured latency fits the deadline. Off by default even then.
14. **Approvals** (§14.2) last of all, and only in a project whose owner asked for it: it is the
    one path that stands between an agent and its next tool call.

Everything from 10 on that runs unasked is `advise`-gated, per project; the three tools in step 9
are only ever called by somebody, which is why they come first. Every step ships with the row of
§16's no-key table that it belongs to, proved by a test. A step that cannot say what happens
without a key is not finished.

And before any of it: a key (section 9), and five minutes in the Playground with a real diff out of
this repository pasted in as the state.
