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
| `packages/forges/core/src/port.ts` | the port: `Forge`, `Review`, `ReviewDetail`, `ReviewRef`, `ReviewState`, `Verdict`, `Thread`, `ReviewQuery`, `Page`, `OpenRequest`, `Patch`/`FilePatch`, `Note`/`NoteReceipt`, `ForgeCapabilities`, `ForgeTrouble`, `ForgeError`, `hostOf`, `repoOf` |
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
| `packages/extensions/review/src/reviewing.ts` | reviewing somebody's pull request, as policy: `REVIEW_ACTS`/`ACT_SETTINGS`/`Grants`, `mayI`, `grantProblem`, `reviewVersion`/`reviewKey`/`fixKey`/`keyIsAbout`, `marker`/`markedBy`/`oursAlready`, `FINDING_KINDS`/`findingFrom`, `anchorsIn`/`anchored`, `wouldLeak`, `whyNotReview`/`whyNotFix`/`reviewerOf`, `GRANTS_ARE_LOCAL`, `NOT_A_VERDICT`, `OUR_REVIEW_IS_MATERIAL` |
| `packages/extensions/review/src/reviewer.ts` | what a reviewer reads and the one place that writes: `reviewPack`, `REVIEWER_RUBRIC`, `examineReview`, `publishReview`, `reviewerSettings`, `reviewerTools` |
| `packages/extensions/review/src/reviewer-watch.ts` | the loop: `toReview`, `reviewFix`, `stillWorthIt` |
| `packages/extensions/review/src/format.ts` | every word a person reads: `stateMarks`/`figuresOf`, `rowOf`, `summaryOf`, `listMarkdown`, `showMarkdown`, `threadLines`, `COMMENTS_ARE_MATERIAL` |
| `packages/extensions/review/skills/open-a-review/` | what an *agent* is told to do — the other half, and not this one |
| `test/fixtures/forge/github.ts` | `githubReplay`: a GitHub that answers from files — `files`, `refusesNotes`, and `onNewSide`, which refuses a line comment the served patch does not have, the way the real one does |
| `packages/extensions/review/test/pulls.ts` | what the two reviewing test files share: a real repository, the replay, and the journal lines that stand for work Tade already started |

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

## Reviewing a pull request, which is the other direction

Everything above is about work **Tade offered**. Reviewing is Tade reading somebody's change and
writing in their repository, which is a different act with a different failure mode, so it is a
different set of rules — `reviewing.ts` (policy, pure), `reviewer.ts` (the pack and the two tools)
and `reviewer-watch.ts` (the two watches). **It is off, everywhere, until four lists in the config
say otherwise, and nothing in this repository turns one on.**

- **Four acts, four grants, nobody by default** (`REVIEW_ACTS`, `ACT_SETTINGS`): `review_in` is
  whose pull requests may be reviewed at all, `comment_in` is where a review may be *posted*,
  `fix_in` is where one may *start an agent*, and `push_in` is where that agent is told to push.
  Each is a list of repositories, each empty, and none implies another — the same argument intake's
  `accept`/`reply`/`names` makes. A person who wants Tade to read their changes has not thereby
  asked it to write in somebody's repository.
- **A grant names the host and one repository, and anything else is a configuration mistake**
  (`grantProblem`). `acme/api` names a repository on every forge there is; reading it as one on
  whichever forge is in front of us is how a grant for an internal GitLab comes to allow one on
  github.com. And there is **no pattern**: `acme/*` is the same shape as `from: anybody` — a
  standing allowance over repositories nobody has looked at, including ones made next month — and
  it cannot be handed to a forge as a filter either, because GitHub's `repo:` qualifier takes one
  `owner/name`, so a glob would match in Tade and find nothing there. Matching is host **and**
  name, case-insensitively, every time (`mayI`), and a malformed line makes the look **throw**
  rather than silently match nothing — the one case here where loud beats quiet, because a grant
  that matches nothing looks exactly like a grant that works. An empty repository list is an
  **empty answer and never an unfiltered query** (`openIn`): a forge asked about no repository in
  particular answers about somebody's whole account, and no grant said that.
- **The gates are at the call, not in the prompt.** `review_publish` checks the grant, the caller,
  the state, the head, the kinds, the sentences and what is already posted — in that order, at the
  moment of the call. A rule in a prompt is a rule the diff in front of the model can talk it out
  of, and the diff is the attacker-controlled half.
- **The reviewer is a different task, and that is the whole of its independence.** Not a different
  account, which Tade does not have and must not switch (`accounts` is `never`). `who: 'any'`,
  because the ordinary case is Tade's *own* review being read by an agent that did not write it.
- **Who may publish is read out of the journal** (`reviewerOf`): the task a watch started on *that
  review at that head*. An agent on other work calling `review_publish` is refused by name, and a
  change nothing was sent to read has no review to publish. Derived, like everything else here —
  a table would be wrong the moment somebody force-pushes.
- **A review is of one commit, said everywhere** (`reviewVersion`, in the key, in the marker, in
  the comment a person reads). `review_publish` takes the head it read as an argument and refuses
  when the forge says otherwise; `recheck` drops a finding whose head moved while it queued. The
  forge's `patch` is pinned for the same reason — a review read at one commit and commented on at
  another is a comment on a line that has moved.
- **The replay checks an anchor, so the anchoring is tested and not assumed.** `onNewSide` in the
  fixture refuses a line comment whose line the served patch does not have, exactly as GitHub's
  `422` does, and it is written separately from `anchorsIn` on purpose — a fixture that validated
  with the code under test would agree with it about a line they were both wrong about.
- **Anchors come from the patch and nowhere else** (`anchorsIn`, `anchored`). Three answers, never
  two: the line is in the diff; the file is and the line is not, so it is a note about the file; the
  file is not, so it is **adrift** and is named in the summary. Nothing is dropped in silence and
  nothing is posted against code the reviewer never read. A file the forge handed no patch over for
  has **no** anchors, which is why a binary file can only ever get a note about the file.
- **There is no kind for anything cosmetic** (`FINDING_KINDS`), and `why` is required. That is the
  only reliable way to keep an automated loop off whitespace: a reviewer with a cosmetic opinion has
  nowhere to put it, and a finding whose consequence nobody can state is refused before it is
  rendered. Enforcement by absence, not by a sentence asking nicely.
- **What may never leave is refused, never scrubbed** (`wouldLeak`): a path under this home or a
  checkout, anybody's home directory, a `file://` url, anything shaped like a credential. Per
  finding, so one bad sentence does not take the review with it, and the summary says how many were
  held back without quoting any of them. A sanitiser would post words nobody wrote and would be
  wrong the first time a secret had a shape nobody listed.
- **The marker is the record** (`marker`, `markedBy`). Everything Tade writes on a review carries
  one, which is three things at once: publication is idempotent across a crash with nothing written
  down anywhere (the comments already there are the ledger); the comment watch skips Tade's own
  words, so a review never comes back as a comment to answer; and `review-fix` can tell *its own
  review* from a bot echo and from a person's reply. It is read off the **notes** and never off the
  summary, because the summary is a comment on the review as a whole and `threads` are the
  conversations on its lines — so the summary goes last and only where something else goes with it.
- **One review drives one fix** (`fixKey` carries the head and nothing else), **one fix at a time
  per pull request** (`whyNotFix`), **two rounds a day** (`whyNotReview`, `ROUNDS_HOURS`) and a
  cooldown longer than a CI run is short. Twenty findings are one agent: twenty agents in one
  checkout is worse than the findings were.
- **The pre-start check is in `agent()`, and `recheck` is deliberately not implemented.**
  `recheck` is the hook for "is this still worth starting", and the queue only drives it for an
  **intake** finding: `intakeHold` (`app/src/wire/queue.ts`) answers null for anything else
  "without asking anybody anything". So a `recheck` on these two would be a method nothing calls —
  the same fault as a setting nothing reads. `agent()` is asked only for what work is actually
  started on, and a throw from it is written down as found **with its reason**, never tried again,
  and reported as "could not start work on" (`wire/schedules.ts`). `stillWorthIt` is therefore
  where the grant, the state and the head are read again, plus — for the fix watch — whether a fix
  started in the meantime. If the queue ever learns to ask every watch and not only an intake one,
  that is the place to move this to, and this paragraph is the note saying so.
- **A grant that has gone stops new work and kills nothing.** `nothingToLookAt` returns no findings
  and a sentence; `stillWorthIt` refuses a finding by name. Neither reaches an agent that is
  already running, which would be a remote kill switch — the same rule intake has about an edited
  request.
- **404, a rate limit and nothing coming back are held, never an empty review** (`openIn`,
  `asLookFailed`). A forge reported as "nothing to review" is the one answer that would make the
  loop look finished when it had not started. The cost is in `stillWorthIt` and is written down
  there: a throw from `agent()` burns the key, so a forge that is unreachable in the moment
  between the look and the start loses that review **at that head** until something is pushed —
  which is the lesser of the two against a reviewer started with no diff in front of it.
- **Where a grant is written, and where it deliberately is not.** `config.yaml`, by hand or
  through `tade config`'s file — the four keys are declared (`reviewerSettings`) so an unknown-key
  warning never fires, and the extension's setup guide names them and then says **what is granted
  right now** (`grantedNow`), because "off" and "on for one repository" look identical in a config
  file somebody is scrolling. They are **not** in `setup().fields`, which is the panel a person
  presses enter through: granting is not a step in a wizard. And they are unreachable to the
  orchestrator (`extensions` is a `never` subtree in `reach.ts`) and to a paired device, which can
  never change a setting at all — asserted in `reviewing.test.ts` rather than assumed.
- **The dry run is `review_examine` and the evidence is `review_findings`.** Reading needs no
  grant, so what a review would say can always be seen before anything is allowed to say it, and
  what the two watches found — with the task each started — is already in the journal.
- **What this does not hold, said rather than implied.** `push_in` decides what the fix agent is
  *told* and whether a fix is started at all; it is not a lock on `git push`, because Tade sandboxes
  nothing and says so (`SERVER_RUNS_AS_YOU`). What actually holds a push is `approvals`, and the
  fix agent is told the branch, told to use `review_checkout`, and told to stop rather than push a
  branch of its own. And no path anywhere files a verdict, resolves a conversation, marks anything
  ready, force-pushes or merges: there is no argument one could go in.

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
  origin could not be asked, which is an outage and never a fork. **And a branch of that name on
  the remote is not the same thing as the review's branch** (`originsOwn`): a fork's branch called
  `main` would otherwise check out this repository's own `main` and read as the review, so where
  the sha `ls-remote` reports is not the review's head, the head is looked for *in* that branch
  before anything is checked out, and a local branch of that name that tracks the remote is this
  repository's own and a refusal. A branch already here is
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
  (`surfaces.test.ts`), reviewing's policy with nothing plugged into it (`reviewing.test.ts`), the
  two reviewing tools (`reviewer.test.ts`), the loop and its bounds (`reviewer-loop.test.ts`), and
  `extensionConformance`.
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
