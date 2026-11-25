/** The agent-hint route's credential reference is optional; omission sends unauthenticated requests. */
import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config, plainOptions, resolveAdapterOptions } from '../src/config.ts'

describe('agent-hint credential reference', () => {
  it('resolves no credential reference when the config names none', () => {
    const options = resolveAdapterOptions(plainOptions(Config({})))
    expect(options.apiKeyEnv).toBeUndefined()
  })

  it('leaves apiKeyEnv undefined in plain options when the config names none', () => {
    expect(plainOptions(Config({})).apiKeyEnv).toBeUndefined()
  })

  it('resolves the named credential reference when the config sets apiKeyEnv', () => {
    const options = resolveAdapterOptions(plainOptions(Config({ apiKeyEnv: 'MOTOR_API_KEY' })))
    expect(options.apiKeyEnv).toBe(credentialRef('MOTOR_API_KEY'))
  })
})
