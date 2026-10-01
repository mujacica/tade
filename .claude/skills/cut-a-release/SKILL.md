---
name: cut-a-release
description: Publish Tade to npm as `tade-sh` — how thirty-eight packages become one, why the types come off at publish, what a user's install runs, and the changelog, version, tag and workflow that do the rest. Use when somebody asks for a release, a version bump or a publish, and read it before changing anything under `scripts/release/`, either install script, or how a package declares its `exports`.
---

# Cutting a release

Tade goes out as **one** npm package, `tade-sh`, installing the command `tade`. Everything under
`packages/` ships inside it and nothing else is published. There is no build step here and the
release does not add one: the types come off at publish and the repository still runs `.ts`.

| Path | What |
|---|---|
| `scripts/release/repo.ts` | `ROOT`, `PUBLISHED` (`tade-sh`), `COMMAND` (`tade`), `manifests`, `rootManifest`, `repoUrl`, `git`; `LIVE`, `LIVE_RUN`, `liveTrouble` |
| `scripts/release/stage.ts` | `stage`, `rewrite`, `exportsFor`, and the private `check`, `depsFor`, `manifestFor`; `NOT_SHIPPED`, `AT_ROOT`, `ON_INSTALL`, `DEFAULT_OUT` |
| `scripts/release/changelog.ts` | `releases`, `changelogFor`, `notesFor`, `tags`, `today`, `RELEASE_COMMIT` |
| `scripts/release/release.ts` | the command: `parse`, `refusals`, `smoke`, and the four writes |
| `scripts/check-build-tools.mjs` | the tarball's `preinstall`: `missingFor`, `onPath`, `trouble` |
| `scripts/fix-pty-permissions.mjs` | the tarball's `postinstall`: `homes`, `find` |
| `scripts/install-hooks.mjs` | `prepare`, and the one install script that does **not** ship |
| `packages/cli/src/bin.ts` | the door: `nodeTooOld` before anything is imported, then `nativeTrouble` |
| `packages/cli/src/version.ts` | `version`, `needsNode` — the root manifest, three levels up in both layouts |
| `packages/cli/src/native.ts` | `nativeTrouble`: a dependency that did not load, said in words |
| `packages/drivers/pty/src/helper.ts` | `helperAt`, `helperProblem`: node-pty's `spawn-helper`, and what to type |
| `.github/workflows/release.yml` | tag → gate → pack → smoke → publish; `workflow_dispatch` rehearses |
| `.github/workflows/ci.yml` | the gate itself, offered as `workflow_call` so the release runs *this* one |
| `test/release.test.ts` | what the staged package, the exports map, the rewrite, the changelog and the workflow must be |
| `test/build-tools.test.ts` | `missingFor`, `onPath`, `trouble`, and that the script is silent where it can build |

## The four commands

```sh
TADE_LIVE=1 pnpm vitest run packages/orchestrator/test/live.test.ts
pnpm release 0.2.0 --dry-run          # rehearse; writes nothing outside dist/
pnpm release 0.2.0                    # CHANGELOG.md, the version, a commit, a tag — all local
git push origin main --follow-tags    # the tag is what publishes
```

**The last one is a person's.** Do the first three, say what they produced, and ask — unless whoever
asked for the release already said to push it. Everything up to the tag is undoable in ten seconds;
the push starts a workflow that puts a version on npm, and **a version on npm cannot be taken back
or reused**. This is the same rule as `merge`: the machine prepares, a person lets it out.

## The live test is the first one, and `pnpm release` refuses without it

It is the only test in the repository that uses a real model, and so the only evidence that a model
can pick the right tool out of the descriptions we wrote: every other test tells a fake model which
tool to call, so all sixty descriptions could say the same thing and `pnpm check` would still be
green. The symptom when one of them is ambiguous is not a red test — it is somebody saying "start an
agent on the auth bug" and getting a status report back.

It costs money and needs credentials, so it is skipped unless `TADE_LIVE=1` asks for it, which is
how it came never to have been run at all, through three rewrites of those descriptions. So a green
run writes down which commit it went green against — `<TADE_HOME>/projects/tade/live.json`, where
everything else Tade writes about a project goes, never in the checkout — and `pnpm release` reads it
(`LIVE` and `liveTrouble`, in `repo.ts`, which the test imports so the two cannot drift): no receipt, or
a receipt naming another commit, and the release is refused with the command to run. It is a pure
function of the receipt and the commit, so the refusal itself is tested. The dry run says the same
thing instead of refusing, because a rehearsal that costs a model call is a rehearsal nobody does.

Under a minute, and about a dollar. Run it on the commit you are releasing, after the last change
rather than before it. `--no-live` is the way past a refusal: use it only when the credentials are
the problem, and say that you did.

**A failure is a defect, not a flake.** Usually it means a description that reads unambiguously to
whoever wrote it and ambiguously to a model; the fix is the description, in
`packages/orchestrator/src/tools-extension.ts`, and the golden file
(`packages/orchestrator/test/golden/tools.json`) is where that change shows up in review. Two other
things it can mean, both seen the first time it was run: a capability missing altogether, since a
model cannot choose a tool that does not exist, and a fixture emptier than a real project, which
turns a case into a question the model is right to ask instead of answering.

## One package, and what makes thirty-eight of them resolve as one

Thirty-eight workspace packages, every one of them `private`, ship as a single npm package. `tade`
was taken; `tade-sh` is what the account has, and the command it installs is still `tade` — the two
are `PUBLISHED` and `COMMAND` in `repo.ts`, and nothing else decides either. The one other place the
published name matters to *resolution* is `tadeRoot` in `packages/workbench/src/programs.ts`, which
recognises Tade's own tree **by the CLI under it** rather than by either name, precisely so a rename
of either cannot quietly break it. (It is also spelled out in the install advice a person reads —
`nativeTrouble`, `helperProblem`, `nodeTooOld`'s comment — which is text, not identity.)

- **The tarball keeps the shape it has here.** `packages/<name>/src/…`, the same paths, so nothing
  has to be relocated and no path in the source is written twice.
- **The root manifest declares one `exports` entry per package, generated from that package's own**
  (`exportsFor`). `@tade/mcp-core/protocol` becomes `tade-sh/mcp-core/protocol`, so a subpath a
  package adds tomorrow is answered tomorrow with nothing to remember. `./conformance` is the one
  key dropped, because its file does not ship. `'.'` is the CLI's own index.
- **`@tade/core` is rewritten to `tade-sh/core`**, which Node answers by **self-reference** against
  the nearest package scope. Nothing resolves through `node_modules`, so nothing depends on how a
  package manager chose to lay one out.
- **That is why the staged tree has no nested `package.json`.** One would become the closest package
  scope for the files beside it and every cross-package import would stop resolving. `check()`
  refuses a second manifest anywhere under the staged root for exactly this reason — and it is also
  why `version()` and `needsNode()` read the root manifest **three levels up** from
  `packages/cli/src/`: the same three in a checkout, where it is the workspace root, and in the
  tarball, where it is `tade-sh`'s own.
- **`manifests()` reads the workspace off disk**, one and two deep under `packages/`, taking only
  what names itself `@tade/…`. A package added tomorrow is in the tarball tomorrow with no list to
  update. `test/` is workspace-linked and is left out: it is the fixtures the suite builds
  repositories with, and it ships to nobody.

### What ships out of a package, and what does not

`stage()` walks `git ls-files` per package and takes only what is under **`src/`** or **`skills/`**
— the second is real and easy to forget: the extensions ship the recipes their agents read
(`packages/extensions/*/skills/`). Anything else in a package's folder is a contributor's. `test/`
is not shipped; `NOT_SHIPPED` drops `conformance.ts` and `echo-child.js` by name wherever they
appear, and `AT_ROOT` adds `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md` and `CHANGELOG.md`.

**A file that is not tracked is not staged.** That is the commonest refusal in practice and it
reads as something else: `… names ./y.js, which is not there` on a file you are looking at. `git
add` it.

**Dependencies are folded, never listed** (`depsFor`). Every range the workspace declares, with
`@tade/…` taken out; one published package can hold one range, so two packages disagreeing about
one is a refusal that names both. It is conservative on purpose — a declared dependency nothing
appears to import may still be reached in a way no regular expression sees. **`vitest` is the only
thing dropped**, and only because the files that import it (the conformance suites) do not ship,
which is why the run prints it as `left out:` rather than dropping it silently. `pnpm.onlyBuiltDependencies`
is carried from the root manifest, because pnpm reads it from the project being installed *into*.

## The types come off at publish, and that is not a build step

Node refuses, deliberately, to strip types from any file under a `node_modules` path — and `npm i
-g` puts the package under one. So a tarball of `.ts` would be a tarball that cannot run, with no
flag to ask otherwise. `stage.ts` runs Node's own `stripTypeScriptTypes` in **`strip` mode**, where
types become whitespace: every line of the published package is at the line it is at here, and a
stack trace a user sends back reads against this source. Nothing in the repository was rewritten to
make that work, `pnpm tade` still runs the `.ts`, and there is still no build.

**Two rewrite rules and no others** (`rewrite`):

1. a `@tade/…` specifier becomes `tade-sh/…`;
2. a relative path ending `.ts` becomes the same path ending `.js`.

The second is **not only the imports**: `new URL('./hook.ts', import.meta.url)` is how Claude Code,
Codex and pi are told which file to run, and those paths have to move with the files. A bare
`'extension.ts'` is left alone on purpose — that one names a file in somebody's own
`~/.tade/extensions`, which is not in the tarball and not under `node_modules`, so Node strips its
types the ordinary way.

Which is why `imported()` trusts neither the keyword nor the shape on its own: `line('from',
where.base.replace(…))` reads to a regular expression as an import, and the AppleScript that asks
the pasteboard what it is holding contains a literal `ObjC.import("AppKit")`. A release that stops
on either is a release nobody can cut.

## Choosing the version

Plain semver. `package.json` says where it is now, `git tag --list 'v*'` says what has gone out. A
prerelease (`0.2.0-rc.1`) is accepted everywhere a version is. If which number it should be is not
obvious from what changed, ask — that is a decision, not a lookup.

## The dry run is not optional

It is the only thing that proves the package works, and it is the whole release minus four writes:

- the changelog and the release notes, in `dist/`
- the staged publish directory and the tarball, `dist/tade-sh-<version>.tgz`
- **then it installs that tarball into a directory of its own and runs the `tade` inside it** —
  `--version`, `--help`, `status --json`

That last part is the point. `pnpm check` runs against this checkout, where every `@tade/…`
specifier resolves through pnpm's workspace links; it says nothing at all about whether a package a
stranger installs can find its own files. Answering `--version` at all means every one of the
packages resolved through the generated `exports` map, because the CLI builds its whole command tree
at load.

`--no-smoke` skips the install. Use it only when the network is the problem, and say that you did.

## Reading a refusal

Staging checks itself and throws a list rather than shipping. Every one of these was a way the
staged tree could be wrong on a stranger's machine, which is the one place nobody can debug it:

| it says | it means |
| --- | --- |
| `… is TypeScript` | a file escaped the strip pass — the tarball cannot contain `.ts` |
| `… is a second package.json` | it would become the closest package scope and `tade-sh/core` would stop resolving |
| `exports ./x points at …, which is not there` | a package's own `exports` names a file that does not exist |
| `bin points at …, which is not there` / `… has no shebang` | npm cannot link a bin without one |
| `… names ./y.js, which is not there` | usually a new file that **git does not track yet** — `git add` it |
| `… imports tade-sh/z, which no exports key answers` | a new subpath import with no `exports` entry behind it; add it to that package's own `exports` |
| `… is imported by a file that ships and no package depends on it` | declare it in the dependencies of the package that imports it |
| `… is declared as ^1 and ^2` | one published package can hold one range; make the workspace agree first |

`pnpm release` also refuses before it starts (`refusals`): not on `main`, uncommitted changes,
behind `origin/main`, a tag that already exists, or no live-test receipt for this commit. Each is
said in full rather than one at a time. The uncommitted-changes one matters most here — agents share
this checkout, and a release must carry the changelog and the version and nobody else's work, which
is why the commit is `git add --` by path and never `-a`. Being behind is best effort: a machine
with no network still gets to cut a release, it just does not get told.

## What the workflow does with the tag

`.github/workflows/release.yml`, in order, and each waits for the one before it:

1. **gate** — calls `.github/workflows/ci.yml`, which is `pnpm check` on ubuntu and macOS with the
   suite alone on the machine. Not a copy of the gate: the same file every pull request gets, which
   is why `ci.yml` offers `workflow_call`.
2. **pack** — checks the tag against `package.json`, writes the notes, stages and packs. No
   `pnpm install`: staging reads the workspace off disk and runs `git ls-files`, and if this job
   ever needs dependencies, something has grown a build step.
3. **smoke** — installs the tarball on both systems and runs the `tade` inside it.
4. **publish** — **waits for a person**, then `npm publish --provenance` over OIDC, then the
   GitHub release with the notes and the tarball on it. The wait is the `release` environment and
   its required reviewer: everything above it runs unattended, and the one irreversible step does
   not. Approve it in the run's own page. A rehearsal never reaches this job, so it never asks. It refuses first, by name, if the repository is private: GitHub issues no
   provenance attestation from a private source and npm fails the publish rather than dropping it,
   which would otherwise be a registry error naming none of this at the last step of a ten-minute
   run.

Run the same workflow from the Actions tab with a version instead, and it rehearses: the same gate,
the same tarball, uploaded as artifacts and **published nowhere**.

**Nothing from the event is ever written into a shell line.** A tag name and a `workflow_dispatch`
input are somebody's text, and a `run:` block with `${{ }}` in it is that text becoming the script;
through the environment it stays an argument. `test/release.test.ts` holds the whole workflow to it.

## What a user's install runs is node-pty, twice

`ON_INSTALL` in `stage.ts` is the list, and it is two. Both are about the one thing in the tarball
that is a binary rather than a file. **Nothing else ships and neither reaches the network.**

**`preinstall` is `check-build-tools.mjs`.** node-pty ships prebuilds for darwin and win32 and for
no Linux, so on Linux it is always compiled, and on a machine with no toolchain the install used to
end in forty lines of node-gyp naming a Python that is not Tade's and a working directory nobody
chose. npm runs a package's `preinstall` **before** it builds that package's dependencies, and npm
shows a script's output only when the script *fails* — so it exits non-zero, and the sentence is the
whole of the error instead of a line above the wall where nobody reads it.

It may only ever refuse where node-gyp would have failed anyway. So it looks for what node-gyp
looks for and is generous about what counts: any of six compiler names, either Python, `make`,
`gmake` or `ninja`, and the environment variables node-gyp reads before it looks at all (`CXX`,
`PYTHON`, `npm_config_python`, `MAKE`, `npm_config_ninja`). `missingFor` is empty on every platform
but Linux, and anything it cannot read is not a refusal — node-gyp then speaks, exactly as it did
before this existed. (better-sqlite3 ships prebuilds everywhere and is not why this is here.)

**`postinstall` is `fix-pty-permissions.mjs`.** That same prebuilt `spawn-helper` comes out of a
tarball without its executable bit, and every lane then fails with `posix_spawnp failed.` and no
other word. The script walks up from itself so it finds node-pty in both homes — this repository's
pnpm store, and wherever a user's package manager put it — and fixes only node-pty's own folders,
never a recursive hunt through a global `node_modules`. It never fails an install.

**Nothing fixes it at run time**, and that is deliberate: chmod-ing a file inside somebody's
`node_modules` while Tade is running is a surprise, and the commands that fix it properly are the
ones they will want next time too. So the pty driver's `available()` **and** `open()` both ask
`helperProblem(helperAt())`, and that is where the sentence lives — which file, `chmod +x`, and the
three ways to approve the install script a package manager held rather than ran.

**`install-hooks.mjs` is `prepare`**, which runs for this repository and for a git install and never
for somebody installing the published package. Pointing a stranger's git at hooks in a repository of
theirs is not Tade's business, and `test/release.test.ts` holds the root manifest to it: `prepare`
names it, `postinstall` must not. What it does here is point git at `.githooks` through
`core.hooksPath` — and it leaves a hooks path somebody chose themselves alone unless asked, which is
what `pnpm hooks` is for.

**A dependency that did not load at all is caught once, in `bin.ts`**, and answered by
`nativeTrouble`. It names the module, what the machine said, the toolchain a build needs, and the
commands that approve an install script a package manager held rather than ran — for each of the
three that hold one (pnpm, npm 11, bun). Whether it is native is decided by **how it failed**
(`ERR_DLOPEN_FAILED`, `NODE_MODULE_VERSION`, `Failed to load native module`) and never by whether a
name could be picked out of the message. **A relative file that is missing is Tade's own bug** and
is never dressed up as somebody's install problem: `named()` returns null for anything quoted that
starts with `.` or `/`, and `bin.ts` rethrows the original error, because sending somebody off to
fix a machine that is fine is the worse failure.

## What Socket.dev scores it, and why none of it is a bug

Socket scored 0.1.0 **73 supply chain, 88 maintenance, 99 quality** — 0 vulnerabilities, license
clean — and somebody will want those to be 100. **They cannot be, and every way to raise them is a
thing this package needs taken out of it.** Socket's inputs are published
(`docs.socket.dev/docs/package-scores`), and most of them are **popularity and history rather than
contents**: supply chain reads download count and dependency counts; maintenance reads maintainer
count, version count, versions and commits per window, and issue history; quality reads readme
length, bundle size, stargazers, forks and watchers. At 0.1.0 that was a repository twelve days old
with 0 stars, 0 forks, 0 watchers, 0 issues, 2 versions, 1 maintainer and 11 downloads a week. **No
change to the tarball moves any of those** — releases, time and a second maintainer do, which is
why 88 and 99 are not a list of things to fix. Quality at 99 is already the readme doing its job:
27 KB of it, over 400 lines.

What it does flag in the contents is the product, and the first four are one alert each:

- **`installScripts` (high)** — the two above, and **both** must go to clear it. The section
  above is why neither does: without the `preinstall` a Linux machine with no toolchain gets
  forty lines of node-gyp, and nothing fixes the `spawn-helper` bit at run time *on purpose*.
- **`shellAccess`, `filesystemAccess`, `envVars`, `networkAccess`** — 25, 80, 41 and 11 of the 374
  shipped files. Tade opens terminals, reads config, reads `TADE_HOME` and talks to a forge. A
  control room for coding agents that did none of those would not be one.
- **`hasNativeCode` (high)** — node-pty and better-sqlite3, declared in `onlyBuiltDependencies`.
  **The tarball carries no binary of its own**: 374 `.js`, 2 `.mjs`, 8 `.md`, a `package.json` and
  `LICENSE`, no `eval`, nothing minified, nothing obfuscated.
- **`deprecated` (low)** — `node-domexception`, five deep under the pi harness
  (`pi-coding-agent` → `@google/genai` → `gaxios` → `node-fetch` → `fetch-blob`). **0.99.2 still
  carries it**, so it is ours to report upstream and nobody's to fix here.
- **220 packages resolve for `npm i tade-sh`**, 146 of them nested under the pi harness.
  Dependency count is a real input and the only lever here with a real cost: dropping
  `@sentry/node` would take 8 packages of OpenTelemetry with it and lose Tade reporting its own
  trouble, which is a worse trade than a number.

**Socket gives an author no way to declare any of this expected.** `socket.yml` and the alert triage
in the dashboard govern Socket's checks on *your* pull requests and your own organization's view —
never the public score — and there is no `package.json` field it reads, so there is nothing to put
in the manifest and no point adding `author` for it (`missingAuthor` is about a *deleted npm
account*, not a missing field). This section is the answer to the number instead. **The one score
that would be a bug is the vulnerability count**, and `deps_check` is what watches it.

## When it goes wrong

- **Red gate, or a failed smoke.** Nothing was published — publish is the last job. Fix it, then
  `git tag -d vX.Y.Z && git push --delete origin vX.Y.Z`, and go again — **except that a `v*` tag
  can no longer be deleted or moved on the remote**: the `released versions are immutable` ruleset
  refuses both, because a published version's provenance names its tag and a tag that can move is a
  tag that proves nothing. So the version is spent. Cut the next patch instead, and **rehearse from
  the Actions tab first** — `workflow_dispatch` runs the same gate, pack and smoke, publishes
  nothing, and costs nothing now the repository is public. Do that before every tag and a tag only
  ever lands on a tree whose gate has already passed.
- **Published, and it should not have been.** There is no way back. `npm deprecate tade-sh@X.Y.Z
  "…"` says so on the page, and the fix is the next version, not this one.
- **A release that was never pushed.** `git tag -d vX.Y.Z`, then `git reset --soft HEAD~1` puts
  `CHANGELOG.md` and `package.json` back in the index for you. `--soft` touches no file on disk,
  which is what makes it safe in a checkout other agents are working in — `--hard` there would throw
  away somebody's afternoon.

## Before the first release, once

A person's, at a keyboard, and not something an agent can or should do. Say it to them:

- **npm** — npmjs.com/package/tade-sh → Settings → Trusted publisher → GitHub Actions, with the
  organization or user, the repository, workflow filename `release.yml` (the filename, not a path,
  and with the extension), and the environment left blank. **Then tick `npm publish` under "Allowed
  actions"**: a publisher configured after 2026-09-03 defaults to `npm stage publish` alone, and the
  publish job runs a plain `npm publish`. Leave that default and the last step of a ten-minute run
  does not put the version out — npm's own documentation does not say whether it fails or parks it
  behind a 2FA approval, and either way somebody has to come back to it. Nothing in this repository
  can check that box from here, which is why it is written down.
- **GitHub** — nothing. The workflow declares its own `permissions` and reads no secret. The
  repository has to be **public** for provenance; see the publish job.

Two things the workflow already handles, so that nobody adds them again: `--provenance` is
redundant under trusted publishing, which attests by default, and harmless; and `npm install -g
npm@latest` is there because trusted publishing wants npm ≥ 11.5.1 and the Node 22 the workflow
pins ships npm 10.

**Never add an npm token.** Trusted publishing hands the workflow a token good for one publish of
one package from one workflow; a token in a repository is a credential that outlives every reason it
was added. `test/release.test.ts` fails if a `secrets.` reference appears in that workflow at all.

## Things not to do

- **Do not hand-edit `CHANGELOG.md`.** It is generated from the commit subjects, verbatim, by
  `pnpm changelog`. This repository writes subjects as sentences and explains the reasoning in the
  body; nothing reshapes them into `feat:` and `fix:`, and nothing invents a prefix. If a line reads
  badly, the commit read badly.
- **Do not add a build step.** The types come off at publish, with Node's own `stripTypeScriptTypes`,
  for the reason above. `pnpm tade` still runs the `.ts` and always will.
- **Do not put a `package.json` inside a package's shipped tree**, and do not answer a resolution
  problem by adding one. It becomes the closest package scope and self-reference stops working.
- **Do not add a third install script**, and do not make either of the two do anything but what it
  does. A user's install runs what a user's install needs: node-pty, twice.
- **Do not publish from a laptop.** `npm publish` by hand has no gate behind it, no provenance and
  no record. The tag is the way.
- **Do not put a release commit in the changelog.** `pnpm release` writes `Release X.Y.Z` and
  `RELEASE_COMMIT` drops exactly that subject. Word it any other way and it lists itself.

## If you change any of this

- **A package's `exports`** — nothing else to do; the map is generated. Run the dry run, which is
  what proves the new subpath resolves from outside the workspace.
- **A new folder in a package that has to ship** — `stage()` takes `src/` and `skills/` and nothing
  else. Add it there, and expect the `check()` pass to have an opinion.
- **A new dependency** — declare it on the package that imports it, make sure no other package
  declares a different range, and run `pnpm notices`.
- **The rewrite, the exports map, the refusals or either install script** — `test/release.test.ts`
  and `test/build-tools.test.ts` hold the parts that would otherwise break quietly: what
  `liveTrouble` refuses and what satisfies it, what the published manifest says (down to
  `engines.node`, the two install scripts existing, `vitest` being absent and the native modules
  being present), that the exports map answers every `@tade/…` specifier this repository actually
  writes, what the two rewrite rules do and do not touch, and the handful of facts about the
  workflow — that its gate calls `ci.yml`, that `ci.yml` still offers `workflow_call`, that a push
  to main is not a trigger, that no `run:` block carries a `${{ }}` expression, and that every
  script it names exists.
- **The floor `engines.node` declares** — that number is read at the door by `needsNode`, and how it
  is enforced is `set-up-the-machine`'s.

Run `pnpm check`, and then the dry run, which is the only one that proves the thing itself.
