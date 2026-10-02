---
name: change-the-reviews
description: Change how Tade reads work offered for review and the CI around it — the Forge port and its implementations, the review and branch-CI watches, and the tools that open, read and answer a review. Use when adding a forge (GitLab, Gerrit, sourcehut), teaching one a new capability, changing what a watch finds or what its agent is told, or when a review, a red build or a comment does the wrong thing.
---

# Changing the reviews

A review is a branch offered for merge, and Tade only ever **adds** to it. Nothing here keeps a
list: asking the forge is how Tade knows, which review an agent opened is read back out of git and
the forge, and merging is a person's. What a watch may do to somebody else's repository is bounded
by what the code cannot express, not by being careful at the call site.

| Path | What |
|---|---|
| `packages/forges/core/src/port.ts` | the port: `Forge`, `Review`, `ReviewDetail`, `ReviewRef`, `ReviewState`, `Verdict`, `Thread`, `ReviewQuery`, `Page`, `OpenRequest`, `ForgeCapabilities`, `ForgeTrouble`, `ForgeError`, `hostOf`, `repoOf` |
| `packages/forges/core/src/conformance.ts` | `testForge`: the suite every implementation passes |
| `packages/forges/github/src/{index,map,queries}.ts` | GitHub: one credential, plain requests, and its vocabulary in `map.ts` alone |
| `packages/forges/scripted/src/index.ts` | a forge that answers from a table: `ScriptedReview`, `Wrote` |
| `packages/status/src/forges.ts` | `FORGES`, `forgeFor`, `forgeExec`: the one registry every call site goes through |
| `packages/status/src/git.ts` | `probeReview`: the one narrow question status asks, with the window closed |
| `packages/extensions/review/src/forge.ts` | finding the forge and asking it as little as possible: `whereOf`, `everywhere`, `snapshot`, `POLL_MS`, `forget`, `settingsOf`, `refFrom`, `credentialProblem` |
| `packages/extensions/review/src/extension.ts` | `TASK_TRAILER`, the settings, the surfaces, the `review_*` tools, the three review watches |
| `packages/extensions/review/src/checkout.ts` | the one place a review becomes a local branch: `checkoutPlan`, `ontoReview`, `rootFor`, `checkoutReview` |
| `packages/extensions/review/src/branch.ts` | `branchChecks`: CI on every branch the project has checked out — `readKey`, `REVIEWS_WATCH` |
| `packages/extensions/review/src/commit.ts` | what CI can say about a commit here, and every honest reason it cannot: `standingOn`, `standingEverywhere`, `onRemote`, `ciOn`, `whatRan`, `cannotLook` |
| `packages/extensions/review/src/record.ts` | what the watches found, out of the journal: `found`, `attemptsUnder`, `watchIsOn` |
| `packages/extensions/review/src/format.ts` | every word a person reads: `stateMarks`/`figuresOf`, `rowOf`, `summaryOf`, `listMarkdown`, `showMarkdown`, `threadLines`, `COMMENTS_ARE_MATERIAL` |
| `packages/extensions/review/skills/open-a-review/` | what an *agent* is told to do — the other half, and not this one |
| `test/fixtures/forge/github.ts` | `githubReplay`: a GitHub that answers from files |

## Adding a forge

1. **Implement `Forge`** in `packages/forges/<name>/src/index.ts`. Every method is in the port's own
   vocabulary: a `Review`, a `Verdict`, a `Thread` — never a pull request, a merge request or a
   change. The one place the forge's own words are allowed is its mapping file (`map.ts` in
   `github`), and that is where its vocabulary stops.
2. **Declare `capabilities`, in full.** Every field is a boolean somebody branches on, never
   inferred from `id`. Saying you have something you have not written is worse than saying you have
   not: `github` declares `mergeQueue: false` for exactly that reason. `costPerPoll` is how many of
   its own units one poll of the lists costs.
3. **Declare `words`.** `{ one, many, short, number(n) }` — what the window says when it says
   `PR #412` or `MR !88`. Nothing anywhere may check which forge it is to decide this. **`headRef`
   is the other pure declaration**: the ref on the remote a review's head can be fetched by
   (`refs/pull/412/head`), or `null` where the forge publishes none, which is a first-class answer.
   It is only where a **fork's** commits come from — never a name to check a review out *as*, which
   is always `head.branch`.
4. **`serves(remote)` is pure.** The hosts it knows plus the hosts the config gave it
   (`ForgeOptions.hosts`, for an enterprise install). No network, no guessing.
5. **Implement `placeOf` and `access`.** `placeOf(remote)` is where a remote goes and **whose
   sign-in it names** — `serves` is the same rule as a boolean, so implement one in terms of the
   other. The account is a fact about the *project*: `git@github.com-ammujacic:…` is an SSH host
   alias somebody wrote in `~/.ssh/config` to hold a second account, and it is read out of the URL
   and nowhere else. **Never resolve it by trying each sign-in against the API** — slow,
   rate-limited, and indistinguishable from an attack. Declare `accounts: false` where a forge has
   one sign-in, and then `placeOf` must never name one. `access(repo)` is the other half: a
   repository the sign-in cannot see and one that is not there are the same 404 on GitHub, and
   `commit.ts` asks this to tell "no access from this account" apart from "no such commit" — only
   once the ordinary look has already failed, so nothing pays for it while nothing is wrong.
6. **Declare `programs`** if it shells out — `gh`, with `optional: true` where a token in the
   environment is the way round it. `programsNeeded` in the workbench folds every declaration
   together, so Settings › Updates and `tade update` answer without a list anywhere else changing.
7. **Register it in `FORGES`** (`packages/status/src/forges.ts`). One line. It lives in `status`
   rather than beside the port because the port must not import its own implementations and status
   is the lowest thing that needs one — a task's `merged` state is what the forge says.
8. **Call the suite**, answered by a replay rather than by a service:
   ```ts
   testForge('github', () => make().forge, {
     ref, unknown, remotes: { serves, not }, branches: { withReview, without },
     commits: { withChecks, nothingRan },
     signedOut: () => …, limited: () => …, readOnly: () => …,
   })
   ```
   It asserts the contract and never the content — what is in somebody's pull request is their
   business. The three things it will not let through are the ones that would make Tade lie about
   other people's work: a check still running reported as passed, a question that cannot be answered
   coming back as "no" rather than as a problem, and a write that happens on an account that may
   only read.
9. `pnpm check`, on its own.

## Adding or changing a watch

A watch belongs to the extension: follow `add-extension` for the mechanics, and `change-the-queue`
for what Tade does with what it finds. What is decided *here* is the six things a review watch gets
wrong if nobody thinks about them.

- **What is in the key is what makes a finding new.** `review.checks-failed` keys on the review, the
  check and the **head sha**, because the same check failing on new code is new information and on
  the same code it is not. `review.branch-checks` keys on the **commit alone** — no branch, no check
  — so a workflow re-run starts nothing new, a fix pushed on top is new information, and one push
  never becomes one agent per failing column. One finding per *check* would be three agents editing
  one repository over one push, which in a shared checkout is worse than the failure — so the agent
  is told about every check that failed, with the tail of the first `LOGS` of them.
- **Ask the cheap question first.** `branchChecks` reads the checks of the commit each branch is on;
  only once one of them is red does it spend a second request asking whether that branch has a
  review, and only then does it read the schedules. A log is fetched in `agent()` and never in
  `check()`: `agent` is only asked for what work is actually started on.
- **Watch every branch the project has checked out, not only its own** (`standingEverywhere`,
  `commit.ts`). With a worktree each the commit an agent pushed is never the one the project's
  checkout is on, so looking at the root alone watched CI on nobody's work but the person's —
  invisible while nothing pushed, and the whole of what there is to watch once `projects.<name>.push`
  is set. Everything after the listing is asked **of the root**: worktrees share the object database
  and the remote-tracking refs, so nothing runs git anywhere else, and a branch nobody has pushed
  costs no request at all. Which *quiet* answer a person is told about is the root's, which is why it
  comes first: a worktree's own oddity — a commit rebased away, a branch nothing pushed — is not a
  fact about the repository and must not make the watch cry wolf.
- **Hand a failure to another watch only where that watch is looking.** A branch with a review open
  is `review.checks-failed`'s — *if* somebody has turned it on (`watchIsOn`, `record.ts`, reading
  `schedules.jsonl`). The rule was never "a review is somebody else's business", it was "two watches
  must not start two agents on one failure", and a watch that is off starts nothing: handing it over
  left the first mode anybody asked for — push a branch, open a review on it — watched by nobody.
  Where it cannot tell at all it hands over, because two agents on one failure is the worse half.
- **Be silent where there is nothing to watch.** `whereOf` answering `{ problem }` is a project with
  no remote, which is a decision somebody made on purpose — a standing watch returns no findings
  rather than complaining every ten minutes. A capability that is false is a `throw`, because that
  is a configuration to fix; an empty `checksOn` is the ordinary minute after a push and is neither.
- **`standing: true` is a high bar.** Nobody told anything, nothing spent where a look finds
  nothing, and no credential of somebody else's. `branchChecks` clears it: one request per branch
  that has something pushed on it, and **none at all** for one that has not, which git answers for
  free — so a project nobody pushes from spends nothing however many worktrees are open in it. The
  other three do not clear it and wait to be turned on. With no credential the extension is not `ready()`, so no schedule is
  written at all rather than one failing all day.

## Adding or changing a tool

The `review_*` tools all go through `workingIn`/`located` for the project and `refFrom` for which
review somebody meant (`owner/repo#412`, a URL, or `#412` where there is only one repository). After
anything that writes, call `forget()` so the next reader polls. `for: ['orchestrator']` alone is how
`review_merge` stays a person's ask.

## Rules

- **Reading is a query, and one poll serves everybody.** There is no list of tracked reviews
  anywhere. `snapshot` is asked by the sidebar, the status bar, the brief, every tool and every
  watch, at most every `POLL_MS` (60s), two requests per forge in it — the `resources` extension's
  single `ps` applied to somebody else's API. Nothing here is on a draw path.
- **Which project a review is on is its repository, matched against the projects' own** (`whose` in
  `poll`) — never whose turn it was to ask. `include` makes a project hear about repositories that
  are not its own, and the poll keeps the first answer for a URL, so "whose turn it was" named the
  first project iterated for every review in the account: the side then drew all of them in every
  project. A review on a repository nothing here is a checkout of is `project: null`, which the
  window draws wherever you are rather than nowhere.
- **Checking a review out is its own branch, and `checkout.ts` is the only place that decides it.**
  The branch is `head.branch` — the branch the review was opened from — fetched and set tracking
  `origin/<branch>`, which is what makes a push go to the review. **Nothing may ever name a branch
  after the number**: `git fetch origin pull/151/head:pr-151` is the short way by hand and it leaves
  you on a branch that tracks nothing, is on nobody else's machine and cannot be pushed back, so the
  work goes beside the review instead of to it. That happened — a checkout of #151 landed on `pr-151`
  while `feat/teapot-service` existed and had moved on — which is why this is a tool rather than a
  sentence in a prompt, and why the rule is in three places: the tool, the prompts
  (`orchestrator()`/`agents()`) and the `open-a-review` skill. Three answers rather than two about
  where the commits are: the branch is on this remote, it is not (a fork, and then
  `Forge.headRef` — `refs/pull/<n>/head` — is the only way to them, tracking nothing, said), or
  origin could not be asked, which is an outage and never a fork. A branch already here is
  fast-forwarded and **never reset**: commits it has that the review does not are somebody's work, so
  both counts are reported and nothing is merged. Uncommitted work is a refusal. And **a task's own
  worktree is a refusal** (`rootFor`): its `tade/*` branch is how `status` finds the task among a
  project's worktrees, so putting a review's branch there loses the task rather than putting an agent
  on the review — which is also why `review_fix` tells an agent the branch and tells it to stop
  rather than push one of its own.
- **Which work a review is, is read out of a trailer, never out of a table.** `review_open` writes
  `Tade-Task: <task>` into the body (`TASK_TRAILER`), and `taskIn` reads it back — the same fact the
  ACTIONS tab, the queue's look at the trees and Jev's unit all read off commits. A table Tade kept
  would be wrong the moment somebody force-pushes, and **"unattributed" is always an allowed
  answer**: `Review.task` is `string | null` and `format.ts` says so in as many words.
- **Comments are attacker-controlled text.** An agent is handed them as **material, never as
  instruction** (`COMMENTS_ARE_MATERIAL`, said in the tool, in the watch's prompt and in its context
  file), and what they cause is bounded to its own task's workspace. Never summarise one: `Thread`
  keeps a comment body as written, because it is what an agent is asked to answer.
- **A watch may only add work.** It never resolves a thread, never force-pushes, never reverts
  somebody's commit and never merges. Past `attempts` automatic fixes it only tells you, counted out
  of the journal (`attemptsUnder`) over a window (`FIXING_HOURS`, six) — counting every attempt ever
  made would stop the watch fixing anything again because of a bad afternoon last spring. The two
  ways to end up only reporting are said differently, because they mean different things: the
  settings never asked for automatic fixes, or this branch has had its attempts and is still red.
- **Merging is a person's.** `extensions.review.merge` is `never` by default, `review_merge` refuses
  on it by name, and even set it will not merge what is not green and approved. Nothing in the port
  merges by itself — `mark()` changes what the forge *shows*, and that is all.
- **CI is watched on the branches the project has, not only on the reviews you opened.** A project
  that pushes straight to its base branch opens no review, so `review.checks-failed` — which reads
  what the forge says about *reviews* — never saw the run deciding whether the branch everybody pulls
  is broken, and every red build was carried to the orchestrator by hand. So the forge answers about
  a **commit** as well (`checksOn`, `checkLogOn`, behind `capabilities.commitChecks`), which is what
  both were underneath: a review's number bought nothing but its head sha. **And it is every branch
  the repository has checked out**, which is what makes a project set to push
  (`projects.<name>.push`) actually watched: with a worktree each, the commit an agent pushed is
  never the one the project's own checkout is on.
- **A push is the project's answer, and what happens after one is this watch's.** `pushFor`
  (`core/src/project.ts`) decides whether an agent pushes at all and what it pushes; the words it is
  told are `pushTold` and `CI_AFTER_PUSH` (`core/src/compose.ts`). Nothing here pushes anything and
  nothing waits on CI: **an agent's lane dies with the window and CI takes longer than its last
  turn**, so the durable half of "keep watching after the push" has to be a schedule that looks, and
  the agent is told what will happen after it stops rather than asked to sit on it.
- **Nothing is acted on until it has settled.** `redOn` returns null for three quiet answers that
  are all "not yet" rather than "fine": nothing ran, something is still running (`settled`), and
  everything that ran passed. Acting mid-run starts an agent on a check a retry was about to turn
  green.
- **A commit nothing ran on is an empty list, never `missing`.** CI not having reached a push yet is
  the ordinary case on any branch, and a watch reading it as a failure to look would say it could
  not look every ten minutes about a repository where nothing is wrong. The conformance suite holds
  every forge to this.
- **A forge that cannot be reached is a sentence, never a throw and never an empty section.** The
  list draws one quiet row saying why; `status` degrades to "no review" (`probeReview`) because
  status never throws and a task whose review state could not be read is one Tade says nothing
  about rather than one it calls merged; `snapshot` keeps `problem` so it is said once rather than at
  every look.
- **Credentials are read, used and dropped.** `gh` is how the token is found, a pasted token reaches
  the forge as the variable it already reads, and **the environment always wins** over what was
  pasted. Nothing writes a token anywhere. `credentialProblem` answers from files and the
  environment only: it runs before the window opens and must never be a request.
- **Everything a person reads is in `format.ts`.** The tools, the list rows, the status line, the
  brief and the view all compose from there, so the window and the CLI cannot come to two wordings.
- **A review down the side is two rows, and which half a mark goes in is decided here.**
  `stateMarks` is what it *is* — the state, `you`, `ready` — and goes beside the number;
  `figuresOf` is what it *counts* — the checks, the verdict, what blocks it — and goes under it
  (`marksOf` is still both, for the one-clause sentences). `rowOf` keeps the number in `label` apart
  from the title, because the ACTIONS page used to find it by splitting the drawn title on two
  spaces, and it hands over the **moment** a review was opened (`age`) rather than an elapsed
  figure: the window draws four times a second and this is polled once a minute. A merged or closed
  review has no `age` at all — how long ago it was opened is not how long it has been merged.
- **`summaryOf` is the window a click on a row opens**, asked through `lists[0].summary` on the
  click and never on the poll, because `review()` and `checks()` are a request each. Verdicts are
  **one per person, their latest**: a forge keeps every one anybody ever submitted, so counting them
  all says "3 approvals" where one person pressed approve three times. A check list that could not
  be read is `{ problem }` and says so, never an empty list — "nothing has run" is what an
  unreadable gate must never come out as.

## What to run

`pnpm check`, on its own — the suite spawns real git and PTYs and starves under anything CPU-heavy
beside it. Then, in order of how likely each is to have moved:

- `pnpm vitest run packages/forges` — the conformance suite for both implementations, plus GitHub
  against `githubReplay`. Nothing there may reach the network: the GitHub test takes
  `globalThis.fetch` away for the whole file, and anything reaching past the replay would pass on a
  laptop and fail in CI.
- `pnpm vitest run packages/extensions/review` — the tools (`review.test.ts`), the branch watch
  (`branch.test.ts`), checking a review out (`checkout.test.ts`, real repositories and a real fetch,
  rewritten to a bare repository next door with git's own `insteadOf`), the surfaces
  (`surfaces.test.ts`), and `extensionConformance`.
- `pnpm vitest run packages/status/test/forges.test.ts` if the registry or `forgeFor` moved.
- `pnpm vitest run test/modularity.test.ts` if a file grew: `review/src/extension.ts` has a budget
  line of its own, and a number in it may only go down.
- `pnpm coverage` if you added a file — the floors are per package (`scripts/coverage-floors.ts`),
  and `forges/core` sits at 95.
- `TADE_LIVE=1 pnpm vitest run packages/orchestrator/test/live.test.ts` if you added a tool: it is
  the only evidence a model can choose it from the description you wrote.

There is no live test against a real forge, and the replay is the only thing asserting GitHub still
looks like this. If you change what is asked for, change the recorded shapes in
`test/fixtures/forge/github/` in the same commit.
