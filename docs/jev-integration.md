# Jev in Wilco

A proposal. Nothing here is built; no existing code changes. Written 2026-09-18, against `jev-1.13`
(released 2026-09-15, three days old at the time of writing).

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
to 1) do not hold. Every one of those has a consequence in section 3.

---

## 2. Providers, auth, cost, limits — and the Wilco entry

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
section 5.

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

### What a Wilco entry looks like

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

`ready()` returns "set `$TYPESAFE_API_KEY`…" when there is no key — no network, per the extension
rules. Everything else (`org`-equivalents, per-project overrides) can wait for a second version.

Two rules for the entry, both from TypeSafe's own docs:

- **Pin `jev-1.13.0`, not `jev-latest`.** An alias moves when they ship, and thresholds tuned against
  one version's distributions are not portable to the next. The response carries the versioned id
  that answered; write it into the journal detail of every finding so a threshold change can be
  argued from evidence.
- **Keep every question and threshold in one file** (`questions.ts` in the extension). This is
  TypeSafe's own advice for reviewability and it happens to be Wilco's: a setting Wilco accepts and
  ignores is worse than one it does not have, and a rubric scattered across call sites is the same
  failure wearing a different hat.

---

## 3. The review loop: every agent's code change, asked of Jev

### The shape

> Every commit an agent makes is read by Jev against a fixed set of security and correctness
> questions plus this repository's own rules. What it reports goes to the orchestrator, which decides
> and queues fix work behind whatever the agent is already doing.

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
4. Wilco already has a thing for "look on a clock, find work, never act on the same finding twice",
   and it is load-bearing. Writing a second mechanism next to it is how two sources of truth start.

*A watch*, because a watch is precisely this: a cheap look on a clock, findings with stable keys, and
what to tell an agent about each. The machinery we would otherwise have to write — turning it on,
the cursor, the seen-set, at most `most` per look, the queue, telling the orchestrator, saying it
once when it starts failing — already exists and is tested:

| What we need | What already does it |
|---|---|
| Turn it on, per project, with settings | `wilco_schedule` → a `watch` schedule (`ExtensionWatch`, `host.watches()`) |
| Look every 15 minutes | `Schedule.when` + `dueNow`; the window's `doLookWith` |
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

The **key** is what makes this work, so it has to be chosen carefully:

```
<commit sha>:<question id>        e.g. 8fc21ab:shell_injection
```

Not the sha alone (one commit can have two different problems, and the second must still start work);
not the question alone (the same class of problem in a later commit is new); not anything containing
a line number or a file path (a rebase, a reformat or a later edit would make the same problem look
new). Amended commits and rebases do change the sha and will be found again — accepted: in a
worktree the review runs on the branch as it stands, and a re-review after a rebase is a cheap
false positive, where a missed real one is not.

### What the look actually does

`check(ctx)` — no model in the harness sense, but it does call Jev, which is the judgement that
decides whether there is a finding at all. Bounded so it stays a *cheap look*:

1. `git log --since` / `<cursor sha>..HEAD` across the project's task branches (via the existing
   `git()` helper in `packages/status`, which already runs detached with a timeout), newest first,
   capped at `commits_per_look` (default 20).
2. For each commit: `git show --stat` plus the patch, with lockfiles, generated files and binaries
   dropped, truncated per file. The state is a JSON object — commit message, files, the task's
   `intent_spoken`, the diff — not a blob of prose, because [State](https://docs.typesafe.ai/concepts/state)
   takes structure and jaggedness #5 punishes irrelevant bulk.
3. One request per commit, every question in it (see below).
4. A finding per question whose probability clears `report`. Title = the question's own words plus
   the commit subject, because **there is no explanation to quote**.
5. `since` = the newest reviewed sha, overlapped by one commit, since the seen-set makes overlap free.

Budget, so this stays honest: the watch timeout is **60 seconds** and the whole point is that a look
which finds nothing costs nothing. 20 commits × one request each, claimed 0.3–0.5s, well inside 1,200
requests/minute. Cost: a 1,500-line diff is roughly 60,000 characters, call it 15k tokens, one input
charge for all questions → **~$0.0006 per commit**; 200 commits in a day is **about 13 cents**. Those
are my arithmetic on their published price, not a measurement. The `budget` setting caps requests per
look so a repository import cannot turn into a bill.

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
test_missing       Does this change alter behaviour without adding or changing a test in the
                   same commit?
severity           (score) How bad would it be to ship this as it stands?
                   ["nothing to say", "worth a comment", "fix before release", "must not ship"]
area               (choice) Which part of the system does this change? <the repo's own subsystems>
```

**This repository's own rules**, which are the interesting half, because `tsc` and Biome cannot
check them and a reviewer has to read for them. Wilco's `AGENTS.md` is already a list of invariants
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

### From a finding to work, without stepping on the agent that is still typing

The human's ask — *"report to orchestrator that will keep running agents after they are done with
their current tasks"* — maps exactly onto `found: 'ask'`, and that should be the **default**:

1. The watch finds `8fc21ab:shell_injection`.
2. `watchFound(..., { told: 'orchestrator' })` writes it down — so it is never found "for the first
   time" again — and the window sends the orchestrator a message with the finding, under the rule
   that Wilco tells the orchestrator and never talks over it.
3. The orchestrator decides. When the fix should wait for the agent that wrote the code, it calls
   `wilco_plan` with `after: [{ agent: '<that task>', why: 'it is still changing these files' }]`, and
   the queue does the waiting — by rule, on every look at the tasks, as far as `max_parallel` allows.
   In a shared checkout that wait is not politeness, it is the thing that stops two agents editing
   the same file.

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
  project?: string,   // the Wilco project; the one you are in when there is one
  ref?: string,       // a commit, a range (main..HEAD), or a task name; HEAD unless said
  paths?: string[],   // only these files
  threshold?: number, // report at or above this probability; the setting unless said
}) : ToolAnswer        // a table: question, probability, confidence, file, commit
for: ['orchestrator', 'agent']
```
Throws when: there is no TypeSafe key (`ready()` says so first, so the tool is not even offered);
the project is unknown or it has to be said which (`ctx.project()` throws that sentence already);
`ref` does not resolve in that repository; the diff is empty after filtering (says so rather than
returning a cheerful nothing); the state is over budget even after truncation, naming what to narrow;
TypeSafe answers 401/422/429/529, with the status and what to do. It does **not** throw on "found
nothing": that is an answer.

```ts
jev_ask({
  state: string | object,        // what to judge
  questions: Array<{ id, type: 'yes-no'|'pick'|'rate', ask: string, options?, levels? }>,
}) : ToolAnswer
for: ['orchestrator', 'agent']
```
The escape hatch, and the thing an agent uses to try a rubric before anyone writes it into the file.
Throws when: `questions` is empty; two questions share an `id`; a `pick` has fewer than two options
or more than 255 (Jev's cardinality limit); a `rate` has fewer than two levels; the state is over
budget. Its description must carry the warning that this model answers the question as written and
cannot count, do arithmetic, or compare dates — that belongs in code.

And the watch:

```ts
watches: [{
  id: 'review', title: 'Review what agents commit', every: '15m',
  means: 'Reads every new commit in the project with Jev, against the security, correctness and
          house-rule questions, and reports what it finds.',
  input: { threshold?: number, questions?: string[], include?: string[], exclude?: string[] },
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

## 4. Powering the Sentry extension

The Sentry extension already reads issues, events, traces, logs, metrics, and hands an agent a fix
with everything Sentry knows in its context. What it cannot do today is **judge**: which of 40 new
issues matters, and what is in a thousand log lines. Those are both System One shapes, and one of
TypeSafe's four published eval workflows is literally agent-trace triage.

These tools belong **in the Sentry extension**, named `sentry_*` — tool names start with their
extension's name, and cross-extension tool calls are not a thing the host offers (nor should they be:
the credentials live with the extension). Sentry gets the judge as a library, not as another
extension's tool. See section 5.

### `sentry_triage`

```ts
sentry_triage({
  project?: string,     // Wilco project or Sentry slug; yours when you are an agent
  query?: string,       // a Sentry search; 'is:unresolved firstSeen:-24h' unless said
  period?: string,      // 24h unless said
  limit?: number,       // up to 100; 25 unless said
}) : ToolAnswer          // issues ranked, with the numbers behind the rank
for: ['orchestrator', 'agent']
```

One Jev request per issue — state is the issue as `sentry_issue` already renders it (title, culprit,
counts, users, release, the relevant own-code frame, breadcrumbs) — asking:

```
ours            (noul)  Does the stack trace point at this project's own code rather than a
                        dependency or the platform?
security        (score) Could this error be a security problem?
                        ["no", "information leak", "auth or data exposure", "exploitable"]
user_impact     (score) How badly is a person using the product affected?
                        ["not noticed", "annoying", "blocked from finishing", "data lost"]
regression      (noul)  Does this read like something that used to work and stopped?
enough_to_fix   (noul)  Is there enough here to find the cause without reproducing it first?
fix_size        (score) How big is the change likely to be? ["one line", "one file", "several
                        files", "a design question"]
```

Code does the ranking — a weighted sum with the weights in the same file as the questions — and the
answer says the numbers, because a rank nobody can argue with is a rank nobody trusts. It **suggests**
`sentry_fix` for the top few above `act`; it never calls it, and never resolves, ignores or assigns
anything (that is `sentry_update_issue`, orchestrator-only, only when asked).

Throws when: Sentry access is missing (the existing `api(ctx)` message); no TypeSafe key; the query
is rejected by Sentry (pass their message through); a partial failure — Jev answered for some issues
and not others — is **not** a throw, it is a table with the failures named in it, because half a
triage is still worth reading.

### `sentry_grep` — asking questions of logs

The jev-grep the human asked for, aimed at the logs and spans Sentry already holds:

```ts
sentry_grep({
  question: string,      // in plain words: 'which of these are the same payment failing twice?'
  dataset?: 'logs'|'errors'|'spans',   // logs unless said
  query?: string,        // a Sentry search to narrow it first — do this, it is free
  project?: string, period?: string,
  limit?: number,        // rows to read, up to 1000; 200 unless said
  keep?: number,         // probability to keep a row; 0.6 unless said
}) : ToolAnswer           // the rows that matched, most likely first, with their probabilities
for: ['orchestrator', 'agent']
```

How it works, from TypeSafe's own line-by-line search cookbook: chunk the rows into batches that fit
the state budget, and ask **one noul per row** in a single request per batch ("does this line match:
`<question>`"), all evaluated in parallel against the shared state. 200 rows of log at ~15 tokens
each is ~3k tokens of state — well inside the limit and roughly **$0.0001 a batch**. Then sort by
probability in code and show what cleared `keep`.

Throws when: `question` is empty; `dataset` is not one of the three; no rows come back for the query
(says so — an empty grep is an answer, so this one does *not* throw); the key or Sentry access is
missing; a batch is refused by TypeSafe with 422, naming the row that was too long.

The same tool shape, over Wilco's own material rather than Sentry's, belongs in the `jev` extension:

```ts
jev_grep({
  question: string,
  source: 'journal'|'transcript'|'lane'|'file',
  task?: string, lane?: string, file?: string,
  period?: string, limit?: number, keep?: number,
}) : ToolAnswer
for: ['orchestrator', 'agent']
```

`journal` reads `events.jsonl` through `readJournal` (no window needed — a question you cannot ask
while a window is open is a question people stop asking); `transcript` reads an agent's pi session;
`lane` reads scrollback from the driver; `file` reads a file in a project. This is how "why did that
agent stop", "which turn first mentioned the migration", and "did anything touch the database" get
answered without reading 4,000 lines. Throws on: an unknown source; `transcript`/`lane` naming a task
or lane that does not exist; a file outside the projects Wilco knows (never read an arbitrary path
because a model asked); the same key/budget cases as above.

Also worth having, cheap, and not a tool: a `status()` item — `jev 41 asked · 0.7¢` — with `view()`
showing the last look, what fired, and what it cost. The resources extension is the model for it.

---

## 5. Standalone tools, or in Wilco?

### Recommendation

**Build it inside Wilco, in three pieces, and publish nothing standalone yet.**

1. **`packages/judges/core`** — a port and its conformance suite. Not an extension: a subsystem, like
   drivers or voice, because more than one thing will judge and we will want to swap what does.
2. **`packages/judges/jev`** and **`packages/judges/scripted`** — the HTTP client, and a judge that
   answers from a table (what tests and `--safe` use; also the honest way to demo the loop with no
   key).
3. **The extensions**: a new `jev` extension (review watch, `jev_review`, `jev_ask`, `jev_grep`), and
   `sentry_triage` / `sentry_grep` added to the Sentry extension. Both take a judge from the registry
   by name; neither knows TypeSafe's URL.

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

- **`wilco extensions run` already is the standalone tool.** `wilco extensions run jev_review
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
have asked for it. Then extracting `@wilco/judges` is a small job precisely because the conformance
suite is already the contract.

---

## 6. Other things the novelty unlocks, ranked

Ranked by how much of an edge **Jev specifically** gives over calling a general model — which is high
when the work is (a) high volume, (b) a bounded decision, (c) latency- or budget-bound, and (d)
better for having a number you can threshold. It collapses to nothing when the answer needs prose.

1. **Reviewing every change, from every agent, always** (section 3). The edge is not quality — a
   frontier model reviews better — it is that at ~$0.0006 and half a second per commit you review
   100% instead of sampling, and you get a probability to route on. This is the one that changes what
   Wilco can promise.
2. **Turn-level supervision of agents.** Wilco sees every turn, tool call and cost. A judgement on
   each one has to be sub-second and free or it cannot exist: *is this agent looping? did this turn
   end without saying anything? is this tool call destructive in a way the policy has not named? is
   this agent stuck waiting for an answer nobody will give?* Today `approvals` is a hand-written
   rule list and "a conversation that goes quiet is the worst failure it has" is watched by nothing.
   TypeSafe's own second-best eval workflow is exactly this shape (agent trace observability, 71.6%).
   Strong edge, and it is the use case the writeup singles out: the harness gets more important, not
   less.
3. **Log, trace and transcript grep** (section 4). A semantic filter over material nobody reads at
   all today, at $0.0001 per 200 lines. Frontier models can do it; nobody runs them over a million
   log lines. Strong edge, mostly on cost.
4. **Sentry triage and ranking** (section 4). Volume is lower (tens of issues, not thousands of
   lines), so the cost edge is smaller and a frontier model is 5–10 points better at the judgement.
   Real, but the weakest of the "obvious" four — worth doing because it shares all the machinery
   with 1–3.
5. **Queue and plan safety.** Before `wilco_plan` starts two agents in one checkout: *will these two
   change the same files?* Would run on every plan, must be fast, and a probability is genuinely the
   right output. Marked down because it needs indirection (a property of a plan of a repository) and
   indirection is on the jaggedness list.
6. **Voice intent routing.** Between the narrow `heard` regexes and a full orchestrator turn there is
   a gap: "did they mean the thing the extension does, or are they talking to me?" At 100ms with a
   confidence to route on — act, confirm, or hand to the orchestrator — that gap closes. Edge is
   mostly latency; the risk is that misrouting a person's words is the most annoying failure Wilco
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

Products beyond Wilco, if we ever wanted them, in the same order of edge: a CI review gate built on
the same question pack (every PR, every push, cents a month); a "question your logs" CLI; a
supervisor sidecar for other people's agent harnesses. All three are section-5 decisions, and my
recommendation there is to defer all of them until the rubric has proven itself on our own commits.

---

## What I could not verify

Everything in this section is a gap, not a claim:

- **Every number in section 2 is provider-reported.** Price, rate limits, latency and the eval
  results all come from TypeSafe. I did not run a single request: this repository has no TypeSafe
  key, and Jev is in selective early access behind a waitlist. I do not know whether we can get
  access, or how quickly.
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
- **Not verified:** the ZDR terms beyond a mention on their Models page; whether `usage.input_tokens`
  is what you are billed for; whether the 1,200 rpm limit is per key or per account; how latency
  behaves as question count grows (they claim "barely changes" — the writeup asks for the same number
  to be measured by someone else, and so should we).
- **The cost arithmetic in section 3 is mine**, from their per-token price and my estimate of diff
  size. Nothing has measured a real diff.

A first step that settles most of this cheaply: get one key, take 200 commits out of this
repository's history, run the question pack over them, and compare what it flags against what code
review actually caught. That is a day's work, it costs about 15 cents in tokens, and it is the only
thing that turns any of the above into a decision.

---

## Appendix: what to build first, in order

1. `packages/judges/core` — port + conformance suite + `JUDGES` registry, with `scripted` passing it.
   No network, no extension, nothing user-visible.
2. `packages/judges/jev` — the client, against a recorded transcript in tests.
3. The measurement above: 200 real commits, one afternoon, a table of what fired and what was true.
   **Go/no-go on that table**, before any of the rest.
4. `packages/extensions/jev` — `jev_review`, `jev_ask`, the `review` watch, questions and thresholds
   in one file, `found: 'ask'` by default. A sketch of it is in
   [`extensions/proposed/jev/extension.ts`](../extensions/proposed/jev/extension.ts) — inert, as
   proposals are.
5. `jev_grep`, then `sentry_triage` and `sentry_grep`.
6. Only then ask again whether anything should leave the repository.
