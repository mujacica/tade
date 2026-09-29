---
name: change-the-spend
description: Change what the agents cost and how long they took — money, tokens, runtime, working time, plan limits, the Spend page and the strip's plan bar. Use when adding a figure, a grouping or a budget, when a harness reports its spend or its plan differently, when a model or provider is filed under the wrong row, or when a total reads as a bug.
---

# Changing what the agents cost

What the agents cost, how long they ran, how many turns and tool calls they took are all **folds over
the journal** — `spendFrom`, `runtimeFrom`, `statsFrom` — because status is a query and nothing here
holds a stopwatch or a running total. Nothing counts anything twice, nothing is kept in a table, and
every figure on the Spend page and in the strip is the same fold read again on the window's beat.

Two currencies with no rate between them run through all of it: **money** (`Spend`, what somebody was
charged) and **a plan's windows** (`PlanWindow`, what a subscription used up). They are never added,
never totalled together, and each has its own type, its own list and its own bar. Beside them sits a
third thing that is neither: **what a plan's turns would have cost at list price** (`usdOnPlan`) —
arithmetic over the same tokens, in no total of money and no budget, and nobody's bill.

| Path | What |
|---|---|
| `packages/core/src/spend.ts` | the fold: `spendFrom`, `Spend`, `noSpend`, `usdExact` / `usdEstimated` / `usdListed`, `usdOnPlan` / `tokensOnPlanUnrated` / `onPlanOf`, `hasCost`, `pricedOf`, `checkBudget`, `modelIdentity`, `modelIn`, `modelDetail`, `modelsSaid`, `modelLastRunOn`, `UNRECORDED`, `HARNESS_FACTS`, `isMoney`, `runFactsOf`, `runFactsFrom`, `accountBucket` |
| `packages/core/src/prices.ts` | what a model costs where nobody will say: `PRICES`, `PRICES_TAKEN`, `priceFor`, `priceKey`, `estimateUsd`, `pricesFrom` — and `config.prices`, the override |
| `packages/core/src/runtime.ts` | how long: `runtimeFrom`, `RUNTIME_EVENTS`, `Runtime`, `workedOf`, `runtimeSays`, `workedSays`, `duration` |
| `packages/core/src/limits.ts` | a plan: `LimitsSupport`, `PlanPays`, `PlanWindow`, `PlanStanding`, `planStandings`, `tightestPlan`, `planShown`, `nextPlan`, `PLAN_WARM`/`PLAN_TIGHT`/`planPressure`, `planReport`, `resetsIn`, `planLabel`, `cannotTell` |
| `packages/core/src/stats.ts` | what it bought: `statsFrom`, `Produced`, `STATS_EVENTS` |
| `packages/harnesses/core/src/port.ts` | what a harness declares: `capabilities.spend` (`usd`, `tokens`, `limits`), `why.limits`, `WorkerAdapter.provider`, `limits()` |
| `packages/workbench/src/accounts.ts` | which sign-ins there are and what each says about its plan: `signIns`, `planSources`, `planWindows` |
| `packages/orchestrator/src/tools-extension.ts`, `tool-host.ts` | `tade_limits`, over `plan/limits` |
| `packages/workbench/src/workers.ts` | what is written down: `usage`, `run_started`, `run_model`, and `agentTurns` for the reporter |
| `packages/workbench/src/workbench.ts` | the two that cannot be re-derived: `lookAtCommits` → `commit_seen`, `lookAtChecks` → `check_ran` |
| `packages/app/src/spend.ts` | `spendView`, `SpendRow`, `PlanRow`, `BudgetRow`, `SPEND_BY`, `SPEND_WINDOWS`, `sinceOf` |
| `packages/app/src/wire/spend.ts` | the `Spend` subject: the fold on the window's beat kept for `REFOLD_MS`, `planUsage` read from what each harness already holds |
| `packages/app/src/panels/spend/state.ts`, `view.ts` | the page: its tabs, `spendColumns`, `nameLines` |
| `packages/app/src/view/foot.ts` | the strip: `planShown`, `nextPlan`, the bars, and what it gives up first |
| `packages/cli/src/commands/spend.ts` | `tade spend`, which reads the journal directly and never opens the workbench |
| `packages/core/test/spend.test.ts`, `limits.test.ts`, `runtime.test.ts`, `stats.test.ts` | the rules |
| `packages/workbench/test/harnesses.test.ts` | `HARNESS_FACTS` held to the adapters, so the two can never drift |
| `packages/app/test/spend-view.test.ts`, `test/screens/scenarios/spend.ts` | the page, and its picture |

## Rules

### A statistic is derived, except the two that cannot be

Everything is a fold. Two things are not recoverable by asking again: **what a commit changed**,
since `git log` answers differently after every rebase and a worktree takes its branch's history with
it when it goes; and **what a check run did**, since a directory's `checks.jsonl` rotates and dies with the
worktree. So each is written down once at the moment it is true — `commit_seen` keyed by sha,
`check_ran` keyed by the run's id — the same way a watch keeps every key it found.

Both are *read* rather than written where they happen (`lookAtCommits`, `lookAtChecks`): `tade check`
runs with no window, and a second writer in one journal would interleave with it, so whichever window
opens next picks up what it missed. The first look at a project counts nothing behind it, because a
chart that spikes on the day you installed Tade is one nobody trusts again. Best effort throughout —
counting things may never be why a window fails to open.

If you want a new statistic, the question is always whether the journal can be asked again. If it
can, fold; if it cannot, write it once, keyed by the thing that makes it unique, and read it back.

### Three kinds of dollar, never added up in silence

A harness declares which it can do (`capabilities.spend.usd`: `exact`, `estimate`, `none`), and that
word rides on every `usage` event as `priced`, so a total can say which it is. pi prices each turn
against its own catalog; Claude Code against an API key estimates; Codex counts tokens and prices
none of them, and **that last case Tade prices itself** (`listedUsd`, `prices.ts`).

- A bucket keeps the three apart (`usdExact`, `usdEstimated`, `usdListed`).
- `pricedOf` is **the one word every surface says it with**, and each kind has its own mark where it
  is read — nothing for a bill, `~` for the harness's guess, `≈` for Tade's — on the row and on the
  total, and nowhere else. A caveat true under every row is a mark and never a footnote.
- The total says **what it is made of in a word** (`MADE_OF`: `billed`, `estimated`, `list prices`,
  `mixed`), under the figure rather than beside it: the head has no columns to spare.
- Money nobody vouched for counts as **guessed, never as priced**.
- A bucket nobody reported money for and nothing could price is drawn `—` rather than `$0.00`, which
  reads as free.

A total may still add the three — a person asking what the morning cost wants one number — but never
in silence.

### What a harness will not price, Tade prices — and only where there is a price to find

`ccusage` exists because a money column with a hole in it sends people to a second program. So where
a harness declares it prices nothing (`priced: 'none'`, or `HARNESS_FACTS` for a line written before
that rode on every event) **and the work was billed per token** (`isMoney`), `spendFrom` prices the
turn itself from its tokens and its model.

- **Only there.** A harness that priced a turn is the thing that knows, and a second figure beside
  its own would be two answers to one question.
- **Never a plan — as money.** A subscription pays a flat fee, so its turns have no per-token cost
  at all: `isMoney` decides that before any figure becomes money, and $954 of list price standing in
  a total beside $78 somebody was billed is the figure that rule exists to refuse. What those same
  tokens *would* have cost is worked out anyway, into `usdOnPlan` — see below.
- **Four rates, not one.** A cache read is a tenth of a fresh prompt and an agent's day is mostly
  cache reads, so `estimateUsd` charges each kind of token at its own rate. Off the input rate alone
  a long run comes out several times what it was.
- **A model with no rate stays unknown** — `priceFor` answers `null`, the tokens count towards
  `tokensUnpriced`, and nothing is invented. A price on a page is indistinguishable from a real one.

**Where the prices live, and why.** A table checked in with the day it was read off the providers'
pages (`PRICES_TAKEN`), overridable per model in `config.prices`, and **never fetched**. A network
lookup breaks the rule that nothing on a timer touches the network and makes reading an old journal
ask the internet what last March cost; a table every user has to fill in is the same hole with extra
steps. The cost is that it goes stale, which the date says out loud and the override fixes without a
release. `priceKey` strips a snapshot stamp (`-20251001`, `@2025-11-01`) and nothing else — a prefix
match would file `gpt-5-mini` under `gpt-5` and charge five times over.

### A plan is not money, so a harness on one reports none

`capabilities.spend.usd` is `none` for Claude Code's own sign-in and `estimate` for an account of it
billed per token. What Claude Code keeps is its own guess at what an API *would* have charged, and on
a flat fee nobody is charged it: **$954 of it stood in this machine's total beside $78 that somebody
was actually billed.** So the adapter reports no dollars at all there (`priceable`, a private helper
in `packages/harnesses/claude/src/adapter.ts`), and what it used up is its plan's windows — their own
type, their own list, their own bar, and in no total (`PlanWindow`).

Tokens and hours stay: unpriced effort is still effort, and is still where it went.

### What a plan's turns would have cost is a fourth figure, and is not a bill

The money column being empty on a subscription is exactly the hole `ccusage` fills, and the answer is
the same one as for a harness that prices nothing: price the tokens off the published rate. The
difference is what may then be done with the answer. A harness that *is* billed per token has a real
bill, estimated — that is `usdListed`, and it is money. A plan has no bill at all, so its figure is a
**counterfactual**: what the same tokens would have come to at list price, which is the number
`ccusage` prints and the number people leave Tade to go and get.

So it is worked out and kept apart, in `usdOnPlan`:

- **In no total of money, ever** — not `usd`, not the three kinds, not `hasCost`, and **not in
  `checkBudget`**: refusing an agent over dollars nobody is charged is a stop nobody can argue with.
  `chargeOf` returns it as its own field for exactly this reason, so no fold can add it by accident.
- **`tokensUnpriced` does not move.** A plan's tokens are still tokens no *money* figure covers, and
  the fold still counts them. What the page does with that is the next rule.
- **It is a floor when it has to be** (`onPlanOf`: `none` / `listed` / `partly`, drawn `≥`). Two ways
  a turn cannot be priced — a model no rate knows, and a line written before usage carried its tokens
  broken down by kind, which a years-long journal is full of — and both count into
  `tokensOnPlanUnrated` rather than quietly shrinking the figure.
- **Drawn per row, and in no total** (`SpendRow.usdOnPlan`, `costCell`). The Spend table's COST
  column says the money, and where a row has none and a plan paid, it says what those turns would
  have cost instead — so the cost of a morning on a subscription is beside the agent that spent it.
  It was a caveat on a line above the table and a `—` in the column, which is the one arrangement
  where the figure is no use: **`≈$779 at list` that somebody has to attribute to an agent by hand is
  a figure they go to `ccusage` for**, which is the whole reason it exists. Beside each sign-in's own
  plan bars as well, and in the strip — where it takes the cost slot when there is no bill at all,
  and its own shedable slot when there is, so no row ever shows it twice. `tade spend` says the whole
  sentence (`onPlanSays`), because there somebody asked.
- **`≈` is the mark and the tone is what separates it from money.** `≈` already means "a rate off a
  published page" and it means that here too: `usdListed` and `usdOnPlan` are the same arithmetic off
  the same table, and the difference is only whether anybody is billed. So the mark cannot carry it
  and the column is not wide enough for the word: the cell is drawn a step quieter (`costTone`:
  plain for a bill, `hint` for a figure somebody worked out, `chrome` for one nobody is charged), and
  what the plain skin loses the PLAN list below keeps — it names every sign-in a plan pays for, with
  `≈$3.74 at list` beside each. **The totals at the head of the page are money and only money**, and
  a figure nobody is charged standing in one of them is still the one thing this page may never draw.

### A subscription is its own currency

Where a plan pays for the work there is no price per turn, so what is used up is a share of a rolling
window — its own type in `core/src/limits.ts`, its own list on the Spend page, its own indicator in
the strip, and in no total anywhere. Every figure is what the *service* told the harness and nothing
Tade counted.

- When a harness can say is **declared** (`capabilities.spend.limits`: `anytime`, `while-working`,
  `none`, each short of full carrying a sentence in `why.limits`) and never sniffed. Both
  subscription harnesses are told as their agents run, so before one has, the honest answer is the
  harness's own sentence rather than zero.
- `planStandings` is where that is decided, and it **throws away a share whose window has already
  started over** (`cannotTell`) — a percentage belonging to a window that is gone looks exactly like
  one that is true, which is the one way this could be worse than saying nothing.
- Nothing here asks anybody anything: the window draws it on its own beat, so `limits()` reads what
  the harness already holds rather than reaching for the network four times a second.
- **Every sign-in is gathered, not only the ones something has run as** (`planSources`, over
  `signIns`): an account that exists and has said nothing is somewhere somebody could go when a plan
  is nearly gone, and an absent row is one nobody can suggest. What pays for each rides along
  (`PlanPays`) — an added account by the kind a person wrote down for it, a harness's own sign-in by
  its own `spend.usd` — because Codex declares it prices nothing on *any* account, which is true of
  Codex and says nothing about who is billed.
- The strip draws the windows of **one** account: the one somebody moved to, and `tightestPlan` until
  they do, which is the one about to stop somebody working. One account and not the fullest window of
  each, since one sign-in's session beside another's week is two answers to one question. Its name is
  the control that moves along (`nextPlan`, `plan-next`), and both the name and the control exist
  exactly where more than one sign-in has something to say — a control that moves between a single
  thing lies about there being somewhere to go. A choice **heals rather than pins** (`planShown`):
  where the account somebody chose has nothing true left to say, the tightest is drawn instead,
  because a stale share is worse than somebody else's figure. Short of room it gives up its trimmings
  before the controls beside it — when each window comes back, then the window that is not the
  tightest, and the bars themselves last — because both are said again one click away on the page it
  opens, and the model and how hard it thinks are said nowhere else.
- **When a plan is worrying is one rule** (`planPressure`, `PLAN_WARM`, `PLAN_TIGHT`): the strip's
  colours, the page's colours and what the orchestrator is told all read it, and it was two copies of
  the same literal before the third reader arrived.
- **The orchestrator reads where every sign-in stands and never moves one** (`planReport`,
  `tade_limits`): used, what is left, when it comes back, who is at their limit, and what else there
  is — ordered by what is known and never by a guess, since "cannot tell" is not "has room". Which
  sign-in agents run as is `never` its to write (`settingReach`: *which sign-in agents run as is a
  sign-in decision*), so the tool says that in its own words and suggests.

### What is true of a harness is true of its old lines too

A journal is years long and holds what every Tade that ever wrote it believed, so the provider a
harness reaches and whether its money is money are applied by the **reader** as well as the writer:
`HARNESS_FACTS`, `isMoney`, `runFactsOf`. A reader has an id and nothing else — the run is over and
its adapter may not exist here any more — so it is a table keyed by the id, held to the adapters by a
test (`packages/workbench/test/harnesses.test.ts`) so the two can never drift.

It only ever **corrects a wish**: nothing is invented for a harness this Tade does not run, nothing
for one that routes, and an account beside a subscription keeps its own money, because it may be
billed per token and the plan says nothing about it.

What this changes is said plainly rather than done quietly: in the journal this was found in, eleven
thousand Claude Code events say `provider: openrouter`, and the money it adds up to went from $3,057
to $785 — every dollar of the difference a plan's own turns, and not one dollar moved from one
provider to another.

### What a run was is written down, never read out of a model's name — and never out of a route's wish

Which harness it ran in, which sign-in it ran as and which provider it was reached through go on
`run_started` and on every `usage` event beside `priced`, for the same reason: they are facts about
the run, and a fact not recorded when it was true is a question nobody can answer later.

The provider is the **harness's** answer (`WorkerAdapter.provider`, declared: `anthropic` for Claude
Code, `openai` for Codex, `null` for pi, which really routes), and only then the route's. A route is a
*wish*: `workers.routes.default` held `provider: openrouter` beside `harness: claude-code`, and Tade
wrote that wish onto eleven thousand runs as a fact, filing every one of them under a router Claude
Code cannot reach.

So the Spend page can ask by harness, by sign-in and by provider as well as by agent, project and
model (`SPEND_BY`) — which is the only thing that tells `claude-opus-5`, `anthropic/claude-opus-5` and
`openrouter/anthropic/claude-opus-5` apart, being one model on a subscription, an API key and a
router. The name is never parsed for it: `anthropic/claude-opus-5` reached through OpenRouter is a
real route, and a guess would file it under Anthropic and look certain. `UNRECORDED` is always an
allowed answer and is drawn as *not recorded*, never as a model called `unknown`.

### A model has one name, and the routing in front of it is not part of it

One model is spelled as many ways as there are ways of reaching it — `claude-opus-5` from Claude
Code, `anthropic/claude-opus-5` from a route against an API key,
`openrouter/anthropic/claude-opus-5` from pi through a router — so added up by the string one agent
becomes four rows, which is what the Spend page was doing with an agent's hours in one and its money
in another.

`modelIdentity` (`core/src/spend.ts`) is the one rule: the **model is the last segment**, everything
in front of it is routing, and the routing is kept rather than thrown away — `id` is the spelling that
reaches it again, which is what starting an agent back up on it needs, and `provider` is what somebody
wrote down and is never read out of the name.

Everything that **writes** a model into an event writes it the same way (`modelDetail`: the name, and
`modelId` only where they differ), and everything that **reads** one reads `modelIn` — so a journal
full of the old spellings folds into the same rows rather than needing a migration nothing could
write. Add a new event carrying a model and it goes through those two, not through a string.

### A run is timed by what it turned out to be on, and says so itself

A route asks for `anthropic/claude-opus-5` and Claude Code answers `claude-opus-5`, so runtime taken
from `run_started` alone lands on a different model row from the money — one agent drawn as two. And a
route that asks for nothing leaves `run_started` with nothing to record at all: pi picks by what you
are signed in to, which was 86 of the 161 runs in the journal this was found in, every hour of them
attributed to nobody.

So the harness saying which model it opened on is written down (`run_model`, from the supervisor's
`started` and `usage` signals — once, and again only when it *changes*), `runtimeFrom` reads it inside
the run it is timing, and `modelsSaid` is the fallback for a journal written before it. A run nothing
ever named is `UNRECORDED`, drawn as *not recorded*.

### How long an agent ran is derived too, never timed

`runtimeFrom` (`core/src/runtime.ts`) reads the journal's `run_started` and `run_exited` and nothing
anywhere holds a stopwatch. A run still open counts up to `now`, because an agent working right now is
running right now. A run nobody wrote an exit for ends where the window closed, or where the next one
opened and relaunched it — counting the hours Tade was shut would add a night's sleep to every agent's
morning. An exit is the thing most often missing: the journal that produced this had 100 `run_started`
in it, 35 `run_exited` and 64 `lane_exited`. The orchestrator is not in it: it has no run of its own,
it lives as long as the window.

**And how long it was *working* is the same fold, one level down.** A run counts until it stopped, idle
time included, which is the honest answer to how long an agent was there and the wrong answer to how
long a model was thinking — the one that pairs with what it cost. So `runtimeFrom` reads the turns
inside each run too (`turn_started`, `turn_done`), **clipped to the run that holds them** so working
time can never exceed the wall clock beside it, and a turn still in flight counts up to `now` like the
run around it. A harness saying a turn began while one already has is the same turn and keeps the
first, because pi says it again every time its socket reconnects mid-turn.

**A run whose turns have ends and no beginnings cannot say, and says that.** `turn_done` has always
been journalled and `turn_started` had not, so every run written before this has finished turns and
nothing to time them by — 7,090 of them in the journal this was built from. That is `unknown` and
**never nought**: a run only reaches this state by having *worked*, so a `0s` would read as an agent
that did nothing, which is the opposite of what happened. `workedOf` is the one answer — `recorded`,
`partly`, `unrecorded`, the shape `pricedOf` has for money and for the same reason — a figure made of
some runs that could say and some that could not is drawn as the floor it is (`≥`), and the journal is
append-only, so the only cure is time.

### How long the agents ran is added across them, and says that in as many words as it takes

`13d 3h` off a machine that has been on since breakfast reads as a bug and is not one: twenty agents
over an afternoon each ran for the whole of their own afternoon, and a run is wall clock from start to
stop, so one that finished at noon and sat in its lane until the window closed counted the wait.

Both are true and both are surprising, so **both are said** — `runtimeSays` in core is the one
sentence, read by `tade spend`, with `workedSays` beside it for the other half — and neither may ever
*explain* it differently from the window. `over 3 runs` is what makes a figure that is not elapsed
time readable, so it is drawn whenever the figure is and is never a step of a ladder that drops it.

It sits **beside** the figures it qualifies, on the head's own line
(`1h 32m working · 2h 5m open · over 3 runs`, `runtimeHead`), because that is where it is read with
them. It had a line of its own under the head while the money's caveats were down there too; those
went into the table, and a line kept for one clause is a footnote, which is what this may never
become. The two words are the two the columns under them are headed with, so the page says which is
which once and in a word.

### Nothing on this page is a sentence

Prose has been cut out of the Spend page **three times**, the last of it
`over 15 runs · 35.0M tokens here ran in a harness that reports no money`, and each time it grew back
because whoever added it was answering a real question. The rule that stops the fourth is the one in
the guide — *a surface is options and values; the explanation lives where somebody asks* — applied
literally here: **the page is marks, figures and headings, and nothing else.**

- A caveat true under every row is a **mark** on the figure (`~`, `≈`, `≥`, `—`), and where the mark
  cannot carry it, a **tone** (`costTone`) — never a tone alone, because the plain skin has none.
- Something neither can carry is a **figure and at most a word** — `billed`, `over 3 runs`,
  `list prices`, `at list`, `cannot tell`, `Nothing in the journal.` — beside the figure it is
  about, never on a line of its own.
- **A figure about a row belongs on that row.** `880k tokens unpriced` and `≈$779 at list` were a
  line above the table saying what the table would not say; both are now in the table, which is why
  that line is gone and may not come back.
- The sentence version of all of it lives in `tade spend` (`pricedSays`, `runtimeSays`, `workedSays`)
  and in `why` on the harness, which is where somebody has asked the question.

If a figure needs explaining and cannot be explained in a word, the figure is wrong.

### The range goes back as far as the journal does, and the page is about money

`SPEND_WINDOWS` and `sinceOf` (`app/src/spend.ts`) are the one answer to "how far back", read by the
Spend page and by every extension's page (`ViewAt.since`, handed the moment rather than the word).
Five ranges: today, since Tade opened, 7 days, 30 days, and **all** — which is nought, the whole
journal, because the events are append-only and every one of them is still there. A range is counted
in midnights rather than rolling hours, so `7 days` is this one and the six before it.

- **A range that found nothing says which range** (`SPEND_WINDOWS[].over`). With one of them
  `Nothing in this window.` was enough; with five it is the answer to four different questions, one
  of which is a range called This window.
- **`all` means `live.spending` is the whole journal**, so the page's fold is kept rather than re-done
  per frame (`REFOLD_MS`, `wire/spend.ts`): four folds a second over forty-six thousand usage events
  is the cost of a page nobody could otherwise ask the question on. Keyed on what went into it — the
  range, the grouping, the two event counts — and re-done a second later whatever, because a run
  still going counts up to now. Held by `test/live.probe.test.ts`, as a ratio against one cold fold.
- **What the money bought is not on this page.** Commits and check runs are an agent's own record and
  are on its ACTIONS page in full — every commit with what it changed, every check with what it
  printed — so two summary lines of the same thing here were a second, shorter answer to a question
  answered better one screen away. `statsFrom` is still the fold and `tade spend` still reports it,
  where somebody asked in full.

### A name is the one column that cannot be abbreviated without lying

So the Spend table is laid out from the room there is (`spendColumns`, `panels/spend/view.ts`): the
figures take what a figure takes, the share meter gives ground first, and everything left is the
name's. Past that it wraps (`nameLines`) and only then ellipsises — and everything cut is cut with
`cap` (`panels/cells.ts`), which says so. Two names that stop dead against the next column read as one
unreadable row, which is how this was reported.

Nothing on this page cuts its own rows to fit and nothing caps a list with `+7 more`: the panel body
is a scroll region like any other, through `scrollBy` and `atOffset`.

## Steps

**A new figure on the Spend page.** Fold it in core, beside the fold that already reads those events
(`spendFrom`, `runtimeFrom`, `statsFrom`) — never in the view, and never with a clock read. Add it to
`SpendRow` / `SpendView` in `app/src/spend.ts`, draw it in `panels/spend/view.ts` through
`spendColumns` so the name still gets what is left, and say what it does not cover with a mark rather
than a sentence. If it can be guessed as well as measured, it needs `pricedOf`'s shape — a `recorded`
/ `partly` / `unrecorded` word and a `≥` where it is a floor — not a number that quietly means two
things.

**A new range to read it over.** Add the id to `SpendWindow`, a row to `SPEND_WINDOWS` with the word
for an empty one (`over`), and the arithmetic to `sinceOf` — all three in `app/src/spend.ts`, because
an extension's page reads the same list. Check what `live.spending` holds reaches that far back, and
that the tabs still fit: past one line they wrap under their own word (`tabRow`), and a tab off the
edge is a range nobody can reach.

**A new way to group it.** Add the id to `SpendBy` and `SPEND_BY` (`app/src/spend.ts`), and make the
bucket key in `spendFrom` out of something that was **written down** — `runFactsOf` is how a run's
harness, account and provider are read back. Never parse a name for it.

**A model whose price has changed, or one the table has never had.** Edit `PRICES` and move
`PRICES_TAKEN` to the day you read it, in the same commit — a rate with somebody else's date on it is
worse than no rate. Somebody on a rate Tade does not ship writes it in `config.prices` instead.

**A harness that reports money differently.** Change the adapter's `capabilities.spend.usd`, and then
change `HARNESS_FACTS` in `core/src/spend.ts` in the same commit: `workbench/test/harnesses.test.ts`
holds the table to the adapters and will fail until you do. Ask whether the old lines in a journal
mean what they said — if the harness never *could* have been charged that way, `isMoney` is what
corrects them for every reader.

**A harness that can say what is left of a plan.** Declare `capabilities.spend.limits` and a sentence
in `why.limits` for anything short of `anytime`, answer `limits()` from what the harness already
holds, and let `planStandings` decide whether the figure is still true. Never total it with money, and
never turn a window that has started over into a percentage. A harness with accounts needs nothing
else: `planSources` walks every sign-in there is.

**A new figure about a plan.** Fold it in `limits.ts` beside the others and read it from all three
readers — the strip, the page and `planReport` — rather than working it out in one of them. Anything
a harness could not say is `null` there and drawn as *cannot tell*; `0` is a figure somebody looked
at. If the figure is in **dollars**, it is not one of those: it goes in `Spend` beside `usdOnPlan`,
never in a total of money, and every surface that draws it says in a word that nobody is billed it.

**A new event carrying a model.** Write it with `modelDetail` and read it with `modelIn`. A model
written as a bare string is a fifth spelling and a fifth row.

**A statistic the journal cannot answer twice.** Write it once at the moment it is true, keyed by the
thing that makes it unique (`commit_seen` by sha, `check_ran` by run id), read it where a window is
open rather than where it happened, and count nothing behind the first look.

Then: a screen scenario for anything drawn (`packages/app/test/screens/scenarios/spend.ts`,
`pnpm screens`, accept on purpose — and the `redraw-the-pictures` skill if the README's pictures
change), `tade spend` saying the same sentence as the window, and `pnpm check` on its own.
