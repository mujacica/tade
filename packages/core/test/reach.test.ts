import { ConfigSchema, namedBy, settingReach, settingsOf, wordsFor } from '@tade/core'
import { describe, expect, it } from 'vitest'

// How far the orchestrator's arm reaches into the config.
//
// The rule is pure, so it is tested as a rule: a path in, a tier out. What is
// being held here is not the list — lists change — but the shape of it, which
// is that everything dangerous is a *subtree* and nothing dangerous is a lone
// key somebody has to remember.

describe('what no words reach', () => {
  it('refuses the gate, whichever key of it is named', () => {
    for (const path of ['approvals.mode', 'approvals.auto_allow', 'approvals.rules']) {
      expect(settingReach(path).reach, path).toBe('never')
    }
  })

  it('refuses a sign-in, an account, and the key an account is paid for with', () => {
    for (const path of ['accounts.work', 'accounts.work.key', 'workers.accounts.pi']) {
      expect(settingReach(path).reach, path).toBe('never')
    }
  })

  it('refuses where a route sends work, while leaving what it thinks with', () => {
    expect(settingReach('workers.routes.default.provider').reach).toBe('never')
    // A model is not a permission: the route's own model, thinking and harness
    // are ordinary settings that happen to live beside a dangerous one.
    expect(settingReach('workers.routes.default.model').reach).toBe('asked')
    expect(settingReach('workers.routes.default.thinking').reach).toBe('asked')
    expect(settingReach('workers.routes.default.harness').reach).toBe('asked')
  })

  it('refuses a whole extension, not only the switch that turns it on', () => {
    // The subtree is the point. `enabled` hands somebody's code to your
    // agents; `org` points an extension that is already on at somebody else's
    // data; `key` is a credential. One rule covers all three, and covers the
    // next key an extension declares on the day it declares it.
    for (const path of ['extensions.sentry.enabled', 'extensions.sentry.org', 'extensions.jev.key'])
      expect(settingReach(path).reach, path).toBe('never')
  })

  it('refuses an MCP server, and the folder its own tools are read from', () => {
    expect(settingReach('mcp.servers.linear.enabled').reach).toBe('never')
    expect(settingReach('orchestrator.extensions').reach).toBe('never')
    // The rest of the orchestrator's own block is ordinary.
    expect(settingReach('orchestrator.model').reach).toBe('asked')
  })

  it('refuses where telemetry is sent, while letting it be turned off', () => {
    // A DSN is an endpoint, not a credential, and this is not about secrecy:
    // it is that changing where Tade sends anything, on the strength of a page
    // it read, is exfiltration whatever the payload. Sending less is not.
    expect(settingReach('telemetry.dsn').reach).toBe('never')
    expect(settingReach('telemetry.errors').reach).toBe('asked')
    expect(settingReach('telemetry.driver').reach).toBe('asked')
  })

  it('refuses moving a project, and allows the rest of its block', () => {
    expect(settingReach('projects.checkout.root').reach).toBe('never')
    expect(settingReach('projects.checkout.brief').reach).toBe('asked')
    expect(settingReach('projects.checkout.budget.usd_per_day').reach).toBe('asked')
    expect(settingReach('projects.checkout.checks.before').reach).toBe('asked')
    // Where a project's agents work is the machine-wide setting asked of one
    // project, and that is `asked`: it decides where the next agent works and
    // widens nothing any agent may do. `root` above stays refused.
    expect(settingReach('projects.checkout.workspace').reach).toBe('asked')
    // How many of its agents work at once says when the next one starts, and
    // nothing about what any of them may do.
    expect(settingReach('projects.checkout.max_parallel').reach).toBe('asked')
    expect(settingReach('checks.suites').reach).toBe('asked')
  })

  it('says why, in a clause somebody can be told', () => {
    for (const path of [
      'approvals.mode',
      'mcp.servers.linear.enabled',
      'telemetry.dsn',
      'surfaces.web.enabled',
    ]) {
      expect(settingReach(path).because.length, path).toBeGreaterThan(20)
    }
    // Nothing to explain where nothing is refused.
    expect(settingReach('surfaces.window.sidebar_width').because).toBe('')
  })
})

describe('what an ordinary request reaches', () => {
  it('is the short list where the worst case is something they are looking at', () => {
    for (const path of [
      'surfaces.window.sidebar_width',
      'surfaces.window.strip_height',
      'surfaces.window.editor',
    ]) {
      expect(settingReach(path).reach, path).toBe('open')
    }
    // And the away view's keys are under `surfaces` too, which is the one
    // place a subtree could have been read as covering them. It does not: the
    // dot is required, so `surfaces.window.*` and `surfaces.web.*` are two
    // subtrees and only one of them is refused.
    expect(settingReach('surfaces.web.enabled').reach).toBe('never')
    expect(settingReach('surfaces.window.sidebar_width').reach).toBe('open')
  })

  it('does not include anything that changes how the work is done', () => {
    for (const path of [
      'agents.commit',
      'agents.workspace',
      'agents.instructions',
      'checks.before',
      // The machine's own push answer, deliberately not beside the per-project
      // one below: it turns pushing on for every project at once, including
      // ones nobody was talking about.
      'agents.push',
    ])
      expect(settingReach(path).reach, path).toBe('asked')
  })

  it('includes what a project pushes, which the person said should be mine to set', () => {
    // The one thing at this tier that is not cosmetic, and the argument for it
    // is a different one: a push mode carries no credential, deletes nothing,
    // and is put back by setting it back. What keeps the boundary is that this
    // is reach over the *setting* and never over the act — the mode is words in
    // an agent's prompt, and `approvals` is what can hold a push. So the
    // orchestrator may say what an agent should do with finished work, and the
    // subtree that says what an agent is *allowed* to do is untouched.
    expect(settingReach('projects.checkout.push').reach).toBe('open')
    expect(settingReach('projects.checkout.push').because).toBe('')
    expect(settingReach('approvals.mode').reach).toBe('never')
    // And it buys nothing else under a project: moving where the work happens
    // is still refused, and a key that merely starts with the same letters is
    // not this one — the pattern is the whole path, so `projects` goes on being
    // the subtree where a key added tomorrow is refused until somebody looks.
    expect(settingReach('projects.checkout.root').reach).toBe('never')
    expect(settingReach('projects.checkout.pushed').reach).toBe('never')
    expect(settingReach('projects.checkout.push.mode').reach).toBe('never')
  })

  it('does not include what the journal keeps, though the worst it can reach is a byte count', () => {
    // `asked`, decided rather than defaulted into. It widens nothing an agent
    // may do, hands nobody tools or a credential, changes who is asked and
    // changes nowhere Tade sends anything — so it is not `never`. And the only
    // lines it can reach are the sampled byte counts, which nothing reads
    // back: there is no wording of it that deletes a commit, a check or a
    // dollar. But it is the size of somebody's own history, which is not a
    // cosmetic annoyance they are looking at, so it is not `open` either.
    expect(settingReach('journal.max_mb').reach).toBe('asked')
  })

  it('does not include how much a lane keeps to scroll back through', () => {
    // `asked`, decided: the drivers' section widens nothing an agent may do,
    // hands nobody anything and sends nothing anywhere. The worst a sentence
    // can do with it is a lane that keeps less history or costs more memory,
    // from the next open on — somebody's own, so not `open` either.
    expect(settingReach('drivers.pty.scrollback').reach).toBe('asked')
  })

  it('does not include how long decided documents are kept, though it can delete one', () => {
    // `asked`, decided: it widens nothing an agent may do and sends nothing
    // anywhere, and the worst a sentence can do with it is age out documents
    // somebody already decided about — never one nobody has, which no value
    // reaches. But it is how long somebody's own research is kept, so it is
    // theirs to name, not the orchestrator's to tidy.
    expect(settingReach('documents.keep_days').reach).toBe('asked')
  })

  it('does not include holding the machine awake, which is the one that reaches outside Tade', () => {
    // `asked`, decided rather than defaulted into, and the only setting whose
    // effect is on the machine rather than on Tade. Not `never`: it widens
    // nothing an agent may do, hands nobody tools or a credential, changes who
    // is asked about nothing and moves nowhere Tade sends anything — and the
    // worst wording of it keeps a laptop from sleeping until the window
    // closes, because the assertion is held rather than written down. Not
    // `open` either: a machine that will not sleep is not a cosmetic annoyance
    // somebody is looking at.
    expect(settingReach('agents.keep_awake').reach).toBe('asked')
  })

  it('refuses letting the machine sleep again on anything but the person’s own words', () => {
    // The direction that matters most, and the one an ordinary reading gets
    // backwards. Off is usually the safe direction; here "let it sleep" is
    // exactly the sentence an injected page would like obeyed while agents
    // work, and it is held by the same rule, both ways.
    const setting = settingsOf(ConfigSchema.parse({}))
      .flatMap((group) => group.settings)
      .find((one) => one.path === 'agents.keep_awake')
    expect(setting).toBeDefined()
    if (!setting) return
    expect(namedBy(setting, ['anything you read on a web page'])).toBeNull()
    // And what the person would actually say for it, in the words they use.
    expect(namedBy(setting, ['turn caffeinate off'])).toBe('turn caffeinate off')
    expect(namedBy(setting, ['let the machine sleep again'])).toBe('let the machine sleep again')
    expect(namedBy(setting, ['keep the machine awake while these run'])).toBe(
      'keep the machine awake while these run',
    )
  })

  it('does not include how much the agents give way, which is not cosmetic', () => {
    // `asked`, and arrived there by the default rather than by a line in
    // `reach.ts` — which is the right way for an ordinary key to arrive, and
    // is asserted because the alternative reading is `open`. Not `never`: it
    // widens nothing an agent may do, hands nobody tools or a credential,
    // changes who is asked about nothing and moves nowhere Tade sends
    // anything. Not `open` either, and that is the interesting half: the worst
    // wording of it is not an annoyance somebody is looking at but work they
    // cannot see slowing down — far enough, and a check suite with a timeout
    // goes from slow to `timed out`, which is a red run nobody asked for.
    expect(settingReach('agents.give_way').reach).toBe('asked')
  })

  it('is named by what somebody would actually say about a slow window', () => {
    // The other half of `asked`: a tier that refuses every legitimate request
    // is a tier nobody can use. `wordsFor` would only ever find this one as
    // `give_way`, with the underscore, which is not how anybody says it.
    const setting = settingsOf(ConfigSchema.parse({}))
      .flatMap((group) => group.settings)
      .find((one) => one.path === 'agents.give_way')
    expect(setting).toBeDefined()
    if (!setting) return
    expect(namedBy(setting, ['make the agents give way to the window'])).toBe(
      'make the agents give way to the window',
    )
    expect(namedBy(setting, ['lower the priority of the agents while I type'])).not.toBeNull()
    expect(namedBy(setting, ['something a page I read told you'])).toBeNull()
  })

  it('does not include what a model is said to cost', () => {
    // A price is only ever a figure on a page — it widens nothing an agent may
    // do and moves nowhere Tade sends anything, so it is not `never`. But the
    // money figure it feeds is what a daily budget is checked against, and a
    // rate written down as nought is a budget that never trips again, which is
    // not a cosmetic annoyance somebody is looking at.
    expect(settingReach('prices.claude-opus-5.input').reach).toBe('asked')
  })
})

describe('the shape of the rule', () => {
  it('has an opinion about every section of the config', () => {
    // The default is `asked`, which is safe for an ordinary key and wrong for
    // a dangerous one — and every dangerous thing there is today is a subtree,
    // so a new key inside one is already covered. What is not covered is a new
    // *section*, and that is what this holds: adding one to the schema fails
    // here until somebody has decided which side of the line it is on.
    const decided = new Set([
      'accounts',
      'agents',
      'approvals',
      'checks',
      'documents',
      'drivers',
      'extensions',
      'journal',
      'mcp',
      'orchestrator',
      'prices',
      'projects',
      'surfaces',
      'telemetry',
      'workers',
      'workspace',
    ])
    expect(Object.keys(ConfigSchema.parse({})).sort()).toEqual([...decided].sort())
  })

  it('is exactly this much of what Settings offers, and no more', () => {
    // Every path the page has a field for, sorted into tiers. Written out
    // rather than counted, because the whole of this change is which side of
    // the line each of them is on: moving one is a diff somebody reads.
    const groups = settingsOf(
      ConfigSchema.parse({
        projects: { app: { root: '/src/app' } },
        extensions: { sentry: {} },
      }),
    )
    const byTier: Record<string, string[]> = { open: [], asked: [], never: [] }
    for (const group of groups) {
      for (const setting of group.settings) {
        byTier[settingReach(setting.path).reach]?.push(setting.path)
      }
    }
    expect(byTier.open).toEqual([
      'surfaces.window.sidebar_width',
      'surfaces.window.strip_height',
      'surfaces.window.editor',
      // The one here that is not a window size, and the one the person asked
      // for: `OPEN_UNDER` in `reach.ts` carries the argument and what it costs.
      'projects.app.push',
    ])
    expect(byTier.never?.sort()).toEqual([
      'approvals.mode',
      'extensions.sentry.brief',
      'extensions.sentry.brief_query',
      'extensions.sentry.enabled',
      'extensions.sentry.org',
      'extensions.sentry.projects',
      'extensions.sentry.token_env',
      'extensions.sentry.url',
      'projects.app.root',
      // The away view's five, and **every one of them `never`**: each either
      // widens who can reach the control room (`enabled`, `bind`), decides
      // what the pairing code says (`port`), names a host whose `https`
      // origin is trusted (`trusted_hosts`), or decides whether a paired
      // device may change anything at all (`acting`). A page the orchestrator
      // read does not get to let anybody in, and it does not get to let a
      // phone park work either. They arrived in Settings with the slices that
      // read them, which is the rule about a setting with no reader; the tier
      // was already decided by subtree, which the test above asserts
      // directly, because a tier is a property of the path and not of whether
      // a page lists it.
      // Intake's own switch, and six of each source's eight: whose words make
      // work, where, whether a person approves it, and what is said back. The
      // other two — which of the owner's templates, and which of its documents
      // — are `asked`, and held below.
      'surfaces.intake.enabled',
      'surfaces.intake.sources.cli.accept',
      'surfaces.intake.sources.cli.from',
      'surfaces.intake.sources.cli.mode',
      // The newest of them, and it arrived `never` without anybody touching
      // this list's rule: whether a status posted to somebody else's tracker
      // may name this machine and this work is disclosure, and the text the
      // orchestrator reads all day does not get to widen it.
      'surfaces.intake.sources.cli.names',
      'surfaces.intake.sources.cli.projects',
      'surfaces.intake.sources.cli.reply',
      // And the GitHub source's eight, by the same one dotted prefix rather
      // than by anybody having listed them: a key added with the connector is
      // `never` on the day it is added, which is the whole point of the
      // subtree. `from` is the loudest of them — it is the list of logins
      // whose labelling starts work here, and the text the orchestrator reads
      // all day does not get to put itself on it.
      'surfaces.intake.sources.github.accept',
      'surfaces.intake.sources.github.from',
      'surfaces.intake.sources.github.mode',
      'surfaces.intake.sources.github.names',
      'surfaces.intake.sources.github.projects',
      'surfaces.intake.sources.github.reply',
      // And Linear's eight, which arrived the same way: nobody added a line to
      // `reach.ts` for them, and `settingReach` had them at `never` before the
      // connector was written. `from` here is a list of Linear **user ids**,
      // and the one thing worth saying about that is that an id is the only
      // spelling a stranger cannot take over — so the key the orchestrator
      // must never reach is also the key whose value a person has to go and
      // look up. Both of those make it `never` rather than `asked`.
      'surfaces.intake.sources.linear.accept',
      'surfaces.intake.sources.linear.from',
      'surfaces.intake.sources.linear.mode',
      'surfaces.intake.sources.linear.names',
      'surfaces.intake.sources.linear.projects',
      'surfaces.intake.sources.linear.reply',
      // And the Slack source's eight, again by the prefix and not by anybody
      // having listed them. Two of these are why the subtree is the rule rather
      // than a list: `reply` is Tade writing into a channel other people read,
      // and `from` is the Slack user ids whose @-mention starts an agent on this
      // machine with these keys. A message in that channel is text the
      // orchestrator may well end up reading, and it does not get to put its
      // author on the list.
      'surfaces.intake.sources.slack.accept',
      'surfaces.intake.sources.slack.from',
      'surfaces.intake.sources.slack.mode',
      'surfaces.intake.sources.slack.names',
      'surfaces.intake.sources.slack.projects',
      'surfaces.intake.sources.slack.reply',
      'surfaces.web.acting',
      'surfaces.web.bind',
      'surfaces.web.drafts',
      'surfaces.web.enabled',
      // `install` and `offline` were here, by the subtree alone, and are not:
      // neither grants a device anything — one puts the static page on a phone
      // already paired and the other lets that phone keep counts it was already
      // shown — so they are `asked`, carved out by name (`ALLOWED_UNDER`).
      // The fourth away-view key, and `never` by the same subtree rather than
      // by a line of its own — which is the property this list is here to
      // show: a key added under `surfaces.web` is refused on the day it is
      // written, by somebody who never read `reach.ts`.
      'surfaces.web.orchestrator',
      'surfaces.web.port',
      'surfaces.web.push',
      'surfaces.web.push_details',
      'surfaces.web.push_key',
      // Whether a device may change a setting at all is, itself, a setting no
      // words reach: the subtree again, and the one key in it a page would most
      // like to turn on.
      'surfaces.web.settings',
      'surfaces.web.trusted_hosts',
      'telemetry.dsn',
    ])
    // The rest — and it is most of them — needs the person's own words.
    expect(byTier.asked?.length).toBeGreaterThan(30)
  })
})

describe('what the person’s own words reach under intake and the away view', () => {
  const rows = settingsOf(ConfigSchema.parse({})).flatMap((group) => group.settings)
  const row = (path: string) => {
    const found = rows.find((one) => one.path === path)
    if (!found) throw new Error(`no row for ${path}`)
    return found
  }

  it('reaches which of the owner’s templates a source stamps, and which document it fills', () => {
    // The owner choosing among what the owner published: a template is an
    // immutable snapshot that makes parked work, and every document input is
    // under the material heading. Nothing here says whose words count.
    for (const source of ['cli', 'github', 'slack', 'linear']) {
      for (const leaf of ['template', 'document']) {
        const path = `surfaces.intake.sources.${source}.${leaf}`
        expect(settingReach(path).reach, path).toBe('asked')
      }
    }
  })

  it('reaches nothing else of a source, and nothing new under one', () => {
    for (const leaf of ['accept', 'projects', 'from', 'mode', 'reply', 'names']) {
      const path = `surfaces.intake.sources.github.${leaf}`
      expect(settingReach(path).reach, path).toBe('never')
    }
    expect(settingReach('surfaces.intake.enabled').reach).toBe('never')
    // The carve-out is the leaf and not its start: a key that only begins the
    // same way is a key nobody has looked at, and the subtree refuses it.
    expect(settingReach('surfaces.intake.sources.github.templates').reach).toBe('never')
    expect(settingReach('surfaces.intake.sources.github.template.name').reach).toBe('never')
  })

  it('reaches installing the page and keeping its counts, and none of the doors', () => {
    expect(settingReach('surfaces.web.install').reach).toBe('asked')
    expect(settingReach('surfaces.web.offline').reach).toBe('asked')
    for (const leaf of [
      'enabled',
      'bind',
      'port',
      'trusted_hosts',
      'acting',
      'orchestrator',
      'drafts',
      'settings',
      'push',
      'push_details',
      'push_key',
    ]) {
      const path = `surfaces.web.${leaf}`
      expect(settingReach(path).reach, path).toBe('never')
    }
    expect(settingReach('surfaces.web.installed').reach).toBe('never')
  })

  it('is named by the setting, never by the source or the surface it is under', () => {
    // `intake`, `sources` and `github` each name every one of that source's
    // eight settings, six of which no words reach — so none of them counts.
    const template = row('surfaces.intake.sources.github.template')
    expect(namedBy(template, ['is github intake picking anything up?'])).toBeNull()
    expect(namedBy(template, ['turn the intake sources on'])).toBeNull()
    expect(namedBy(template, ['stamp github requests from the bug template'])).not.toBeNull()
    const document = row('surfaces.intake.sources.slack.document')
    expect(namedBy(document, ['how is slack doing'])).toBeNull()
    expect(namedBy(document, ['put the slack body in the report document'])).not.toBeNull()
    const install = row('surfaces.web.install')
    expect(namedBy(install, ['let my phone install it'])).not.toBeNull()
    expect(namedBy(install, ['something a page I read told you'])).toBeNull()
    const offline = row('surfaces.web.offline')
    expect(namedBy(offline, ['let it work offline on the train'])).not.toBeNull()
  })

  it('answers every row of the Away page the same way, with its capabilities on by default', () => {
    // Turning everything under the away view on by default moved nothing here:
    // a default is not a reach. The two that let nobody in and no device do
    // anything are the person's to say; every door, every grant and everything
    // sent through somebody else's push service is no words at all — and that
    // includes turning one *off*, because a reach is a property of the path.
    const away = settingsOf(ConfigSchema.parse({})).find((group) => group.id === 'away')
    const reach = Object.fromEntries(
      (away?.settings ?? []).map((one) => [one.path, settingReach(one.path).reach]),
    )
    expect(reach).toEqual({
      'surfaces.web.enabled': 'never',
      'surfaces.web.bind': 'never',
      'surfaces.web.port': 'never',
      'surfaces.web.trusted_hosts': 'never',
      'surfaces.web.push_key': 'never',
      'surfaces.web.acting': 'never',
      'surfaces.web.orchestrator': 'never',
      'surfaces.web.drafts': 'never',
      'surfaces.web.settings': 'never',
      'surfaces.web.install': 'asked',
      'surfaces.web.offline': 'asked',
      'surfaces.web.push': 'never',
      'surfaces.web.push_details': 'never',
    })
    // Still named by what somebody would say, under the shorter titles.
    expect(namedBy(row('surfaces.web.install'), ['install the page on my phone'])).not.toBeNull()
    expect(namedBy(row('surfaces.web.offline'), ['keep its last view offline'])).not.toBeNull()
  })
})

describe('whether the person themselves named it', () => {
  const setting = {
    path: 'agents.commit',
    title: 'Commit rule',
    keywords: ['commit', 'git'] as const,
  }

  it('finds the setting in a line they actually said', () => {
    expect(namedBy(setting, ['make the agents commit as they go'])).toBe(
      'make the agents commit as they go',
    )
    expect(namedBy(setting, ['set agents.commit to never'])).toBe('set agents.commit to never')
  })

  it('finds nothing in a line about something else', () => {
    expect(namedBy(setting, ['how is the refunds agent getting on?'])).toBeNull()
  })

  it('refuses rather than guessing when they said it in other words', () => {
    // The safe direction, and said plainly because it is the cost of the rule:
    // somebody who says "stop saving my work for me" has named nothing, and is
    // asked to say which setting rather than having one guessed at.
    expect(namedBy(setting, ['stop saving my work for me'])).toBeNull()
  })

  it('will not take a word out of the middle of another one', () => {
    expect(namedBy({ path: 'x.commit', title: 'Commit' }, ['recommitted the branch'])).toBeNull()
  })

  it('drops path segments too short to identify anything', () => {
    // `stt` names nothing anybody would say; `voice` does. Five letters is
    // the line. The title always counts, however short it is: it is the name
    // the setting actually has, and a person saying it has named it.
    const words = wordsFor({ path: 'surfaces.voice.stt.driver', title: 'Speech to text' })
    expect(words).toContain('voice')
    expect(words).toContain('speech to text')
    expect(words).not.toContain('stt')
  })

  it('never counts the section, because a section names everything under it', () => {
    expect(wordsFor({ path: 'agents.commit', title: 'Commit rule' })).not.toContain('agents')
    expect(namedBy(setting, ['how are the agents getting on?'])).toBeNull()
  })

  it('never counts a project’s own name inside that project, for the same reason', () => {
    // A project is a section like `agents` is. Its budget is titled after it
    // and its workspace carries it as a keyword, so before this rule "how is
    // the app project getting on?" named every setting the project has — and
    // what the orchestrator does with a setting it has been named is change
    // it. What is left is the half that says which setting.
    const budget = { path: 'projects.app.budget.usd_per_day', title: 'app' }
    expect(wordsFor(budget)).not.toContain('app')
    expect(namedBy(budget, ['how is the app project getting on?'])).toBeNull()
    expect(namedBy(budget, ['give the app project a budget of 20 dollars a day'])).not.toBeNull()
    const workspace = {
      path: 'projects.app.workspace',
      title: 'app — where agents work',
      keywords: ['app', 'workspace', 'worktree', 'checkout'],
    }
    expect(wordsFor(workspace)).not.toContain('app')
    expect(namedBy(workspace, ['what is the app doing?'])).toBeNull()
    expect(namedBy(workspace, ['give app a worktree each'])).not.toBeNull()
    // The dotted path itself always counts, which is what keeps this usable
    // for a thing whose whole path is its name: closing a project is checked
    // that way, against the project's own name and nothing else.
    expect(namedBy({ path: 'app', title: 'app' }, ['close the app project'])).not.toBeNull()
  })

  it('is empty-handed with nothing to look at', () => {
    expect(namedBy(setting, [])).toBeNull()
  })
})
