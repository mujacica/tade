import { describe, expect, it } from 'vitest'
import { problemOf, providerError } from '../src/adapter.ts'
import { effortOnce, throughAnthropic } from '../src/compat.ts'

// Requests a provider in between refuses. Opus 5 through OpenRouter failed
// its very first request, and the orchestrator went quiet without a word.

describe('reasoning effort, said once', () => {
  const perMessage = {
    model: 'anthropic/claude-opus-5',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], output_config: { effort: 'high' } },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'change your model' },
      { role: 'system', content: [], output_config: { effort: 'medium' } },
    ],
    thinking: {
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    },
    output_config: { effort: 'high' },
    betas: [
      'fine-grained-tool-streaming-2025-05-14',
      'mid-conversation-output-config-2026-07-01',
      'thinking-binding-controls-2026-08-01',
    ],
  }

  it('becomes the request’s own effort, with no message or beta that needs routing', () => {
    expect(effortOnce(perMessage)).toEqual({
      model: 'anthropic/claude-opus-5',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'change your model' },
      ],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      betas: ['fine-grained-tool-streaming-2025-05-14'],
    })
  })

  it('leaves a request that needs none of it exactly as it was', () => {
    const plain = { model: 'kimi', messages: [{ role: 'user', content: 'hi' }] }
    expect(effortOnce(plain)).toBe(plain)
    expect(effortOnce(null)).toBeNull()
  })

  it('is left alone on Anthropic’s own API, which takes it', () => {
    expect(throughAnthropic({ baseUrl: 'https://api.anthropic.com' })).toBe(true)
    expect(throughAnthropic({ baseUrl: 'https://openrouter.ai/api' })).toBe(false)
  })
})

describe('a provider’s error', () => {
  it('is its message and status, not a JSON dump', () => {
    expect(
      providerError(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Mid-conversation reasoning effort is not supported."}}',
      ),
    ).toBe('Mid-conversation reasoning effort is not supported. (400)')
    expect(providerError('socket hang up')).toBe('socket hang up')
    expect(providerError('')).toContain('without saying why')
  })

  it('is said when pi retries, gives up, or an extension throws — and nothing else is a problem', () => {
    expect(
      problemOf({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: '529 {"error":{"message":"Overloaded"}}',
      }),
    ).toBe('the model failed, trying again (1 of 3) in 2s: Overloaded (529)')
    expect(problemOf({ type: 'auto_retry_end', success: false, finalError: 'Overloaded' })).toBe(
      'the model kept failing and pi gave up: Overloaded',
    )
    expect(
      problemOf({
        type: 'extension_error',
        extensionPath: '/x/extensions/standup/extension.ts',
        event: 'tool_call',
        error: 'boom',
      }),
    ).toBe('extension.ts failed in tool_call: boom')
    expect(problemOf({ type: 'auto_retry_end', success: true })).toBeNull()
    expect(problemOf({ type: 'turn_end' })).toBeNull()
  })
})
