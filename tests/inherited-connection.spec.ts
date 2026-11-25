import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DEFAULT_BASE_URL, NO_INHERITED_CONNECTION, resolveBaseURL, resolveModels } from '../src/config.ts'
import { INHERIT_SOURCE_ID, readInheritedConnection } from '../src/inherited-connection.ts'

const INHERITED = { baseURL: 'http://192.168.41.153:1025', models: [{ id: 'DeepSeek-V4-Flash' }] }

describe('resolveBaseURL', () => {
  it('honours an explicitly chosen loopback even with an inherited remote', () => {
    expect(resolveBaseURL(DEFAULT_BASE_URL, INHERITED)).toBe(DEFAULT_BASE_URL)
  })
  it('keeps an explicit operator endpoint even when a sibling route disagrees', () => {
    expect(resolveBaseURL('http://operator.example:1025', INHERITED)).toBe('http://operator.example:1025')
  })

  it('inherits the sibling route endpoint when configuration is omitted', () => {
    expect(resolveBaseURL(undefined, INHERITED)).toBe('http://192.168.41.153:1025')
  })

  it('falls through to the environment when no sibling route named an endpoint', () => {
    const environment = { get: (name: string) => name === 'DSH_AGENT_HINT_BASE_URL' ? { value: 'http://env.example:1025' } : undefined }
    expect(resolveBaseURL(undefined, NO_INHERITED_CONNECTION, environment as never)).toBe('http://env.example:1025')
  })

  it('prefers an inherited endpoint over the environment', () => {
    const environment = { get: () => ({ value: 'http://env.example:1025' }) }
    expect(resolveBaseURL(undefined, INHERITED, environment as never)).toBe('http://192.168.41.153:1025')
  })

  it('ignores an empty inherited endpoint and an empty environment value', () => {
    const environment = { get: () => ({ value: '' }) }
    expect(resolveBaseURL(undefined, { baseURL: '' }, environment as never)).toBe(DEFAULT_BASE_URL)
  })

  it('returns the built-in default when nothing else contributes', () => {
    expect(resolveBaseURL(undefined)).toBe(DEFAULT_BASE_URL)
  })
})

describe('resolveModels', () => {
  it('keeps an explicit catalog', () => {
    expect(resolveModels([{ id: 'explicit' }], INHERITED)).toEqual([{ id: 'explicit' }])
  })

  it('inherits the sibling catalog when none was declared', () => {
    expect(resolveModels(undefined, INHERITED)).toEqual([{ id: 'DeepSeek-V4-Flash' }])
  })

  it('returns an empty catalog when neither source declared one', () => {
    expect(resolveModels(undefined, NO_INHERITED_CONNECTION)).toEqual([])
  })

  it('copies the inherited catalog so callers cannot mutate the source', () => {
    const inherited = { models: [{ id: 'shared' }] }
    const resolved = resolveModels(undefined, inherited)
    resolved.push({ id: 'pushed' })
    expect(inherited.models).toEqual([{ id: 'shared' }])
  })
})

describe('readInheritedConnection', () => {
  const withEditor = (configuration: () => unknown): Context => {
    const ctx = new Context()
    ctx.provide('configEditor', { configuration } as never)
    return ctx
  }

  it('reads the endpoint and catalog from the sibling route override', () => {
    const ctx = withEditor(() => [{
      entry: { options: { id: INHERIT_SOURCE_ID } },
      inherited: {},
      override: { baseURL: 'http://192.168.41.153:1025', models: [{ id: 'DeepSeek-V4-Flash' }] },
    }])
    expect(readInheritedConnection(ctx)).toMatchObject({
      baseURL: 'http://192.168.41.153:1025',
      models: [{ id: 'DeepSeek-V4-Flash' }],
    })
  })

  it('lets the override win over the inherited layer', () => {
    const ctx = withEditor(() => [{
      entry: { options: { id: INHERIT_SOURCE_ID } },
      inherited: { baseURL: 'http://template.example:1025' },
      override: { baseURL: 'http://operator.example:1025' },
    }])
    expect(readInheritedConnection(ctx).baseURL).toBe('http://operator.example:1025')
  })

  it('returns nothing when the editor service is absent', () => {
    expect(readInheritedConnection(new Context())).toEqual({})
  })

  it('returns nothing when the sibling entry is absent', () => {
    const ctx = withEditor(() => [{ entry: { options: { id: 'llm-pi-ai' } }, inherited: {}, override: { baseURL: 'http://x' } }])
    expect(readInheritedConnection(ctx)).toEqual({})
  })

  it('surfaces a throwing editor instead of silently rerouting', () => {
    const ctx = withEditor(() => { throw new Error('compose failed') })
    expect(() => readInheritedConnection(ctx)).toThrow('compose failed')
  })

  it('rejects malformed source values', () => {
    const ctx = withEditor(() => [{
      entry: { options: { id: INHERIT_SOURCE_ID } },
      inherited: {},
      override: { baseURL: '', models: 'not-a-list' },
    }])
    expect(() => readInheritedConnection(ctx)).toThrow()
  })
})
