import type { ExtensionContext, ProjectRef } from '@tade/extensions-core'
import type { Judge, Judgement, Question } from '@tade/judges-core'
import { makeJudge } from '@tade/workbench/judges'
import { ACT, BUDGET, REPORT } from './questions.ts'

// Who answers, what it may look at, and what one look may spend.
//
// Nothing here asks anything: it turns settings into a judge from the
// registry, refuses a project nobody named, and counts what has been spent so
// a bad day cannot run away. The judge is taken by name — never constructed at
// a call site — which is what lets the same rubric be answered by TypeSafe, by
// a table in a test, or by whatever answers next.

/** Which judge answers, as the settings say. */
export function judgeName(ctx: ExtensionContext): string {
  const said = ctx.settings.judge
  return typeof said === 'string' && said !== '' ? said : 'jev'
}

/**
 * The key: the environment first — `$TYPESAFE_API_KEY`, or whatever `key_env`
 * names — then the one somebody pasted into Tade, which is kept in the OS
 * keychain or a file of Tade's own. Never from the config, which people commit.
 */
export function keyOf(ctx: ExtensionContext): string {
  return ctx.secret('key')?.value ?? ''
}

/** Where the key came from, for saying so without saying the key. */
export function keyFrom(ctx: ExtensionContext): string | null {
  return ctx.secret('key')?.from ?? null
}

/** The environment variable the key is read from, as the settings have it. */
export function keyVariable(ctx: ExtensionContext): string {
  return typeof ctx.settings.key_env === 'string' && ctx.settings.key_env !== ''
    ? ctx.settings.key_env
    : 'TYPESAFE_API_KEY'
}

/** The judge these settings name, built but not asked. */
export function judgeFor(ctx: ExtensionContext): Judge {
  return makeJudge(judgeName(ctx), {
    key: keyOf(ctx),
    ...(typeof ctx.settings.url === 'string' ? { url: ctx.settings.url } : {}),
    ...(typeof ctx.settings.model === 'string' ? { model: ctx.settings.model } : {}),
    fetch: ctx.fetch,
  })
}

/**
 * What the extension needs before it can be used, or null. Never the network:
 * this is what `ready()` answers with, on every load, unasked.
 */
export function readyProblem(ctx: ExtensionContext): string | null {
  try {
    return judgeFor(ctx).ready()
  } catch (err) {
    // A judge nobody has: a name with a typo in it, most likely.
    return err instanceof Error ? err.message : String(err)
  }
}

/** A number from the settings, or what this file says it is. */
export function numberSetting(ctx: ExtensionContext, key: string, fallback: number): number {
  const said = ctx.settings[key]
  return typeof said === 'number' && Number.isFinite(said) ? said : fallback
}

/** What a question has to reach to be said, and to be worth starting work on. */
export function thresholds(ctx: ExtensionContext): { report: number; act: number } {
  return {
    report: numberSetting(ctx, 'report', REPORT),
    act: numberSetting(ctx, 'act', ACT),
  }
}

/**
 * The project a call is about, refused when the settings do not name it.
 * Nothing is ever sent from a project nobody said could be: with `projects`
 * unset every project Tade knows is fair game, and naming one narrows it.
 */
export function allowed(ctx: ExtensionContext, project: ProjectRef): ProjectRef {
  const named = ctx.settings.projects
  const list = Array.isArray(named) ? named.map(String).filter(Boolean) : null
  if (list && !list.includes(project.name)) {
    throw new Error(
      `${project.name} is not one of the projects Jev may look at (${list.join(', ') || 'none'}): add it to extensions.jev.projects`,
    )
  }
  return project
}

/**
 * One piece of work's asking: the judge, what it has spent, and the ceiling it
 * may not go through. A run that hits the ceiling stops with a sentence rather
 * than quietly reading half of something.
 */
export class Asking {
  readonly judge: Judge
  readonly budget: number
  requests = 0
  usd = 0
  tokens = 0
  /** The version that answered, kept with every finding it caused. */
  version = ''

  constructor(judge: Judge, budget: number) {
    this.judge = judge
    this.budget = budget
  }

  static from(ctx: ExtensionContext): Asking {
    return new Asking(judgeFor(ctx), numberSetting(ctx, 'budget', BUDGET))
  }

  async ask(
    state: unknown,
    questions: readonly Question[],
    signal?: AbortSignal,
  ): Promise<Judgement> {
    if (this.requests >= this.budget) {
      throw new Error(
        `this look has already made ${this.requests} requests, which is what extensions.jev.budget allows: narrow what it reads, or raise the budget`,
      )
    }
    const judged = await this.judge.ask({ state, questions, ...(signal ? { signal } : {}) })
    this.requests += judged.cost.requests
    this.usd += judged.cost.usd ?? 0
    this.tokens += judged.cost.inputTokens ?? 0
    this.version = judged.version
    return judged
  }

  /**
   * Every question about one state, in as few asks as the judge takes. The
   * answers come back in one table, because who asked them in which request is
   * an implementation detail of the judge, not of the rubric.
   */
  async askAll(
    state: unknown,
    questions: readonly Question[],
    signal?: AbortSignal,
  ): Promise<Judgement> {
    const per = Math.max(1, this.judge.capabilities.questionsPerAsk)
    const answers: Record<string, Judgement['answers'][string]> = {}
    let version = ''
    for (let at = 0; at < questions.length; at += per) {
      const judged = await this.ask(state, questions.slice(at, at + per), signal)
      Object.assign(answers, judged.answers)
      version = judged.version
    }
    return {
      version,
      answers,
      cost: { requests: this.requests, inputTokens: this.tokens, usd: this.usd },
    }
  }

  /** What has been spent, in a few words for whoever reads the answer. */
  said(): string {
    const cost = this.usd > 0 ? `, about $${this.usd.toFixed(4)}` : ''
    return `${this.requests} request${this.requests === 1 ? '' : 's'}${cost}`
  }
}
