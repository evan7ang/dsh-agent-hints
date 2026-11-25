import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
// The same read-only script is shipped in the package for operators.
// @ts-expect-error The operator script intentionally has no build-time types.
import { checkInstallation } from '../scripts/check-install.mjs'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    const target = await realpath(dir)
    if (dirname(target).toLowerCase() !== (await realpath(tmpdir())).toLowerCase()
      || !basename(target).startsWith('agenthint-install-check-')
      || target.toLowerCase() !== resolve(dir).toLowerCase()) throw new Error('Unexpected cleanup target')
    await rm(target, { recursive: true, force: true })
  }
})
async function fixture(entry: string, bundle = true) {
  const dir = await mkdtemp(join(tmpdir(), 'agenthint-install-check-')); dirs.push(dir)
  const name = 'dsh-agent-hints'
  const pkg = join(dir, 'node_modules', name)
  await mkdir(join(pkg, 'lib'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: bundle ? [name] : [] } } }))
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, version: 'fixture', type: 'module', main: 'index.js' }))
  await writeFile(join(pkg, 'index.js'), entry)
  await writeFile(join(pkg, 'lib/client.js'), 'window.__ModuleLoader__.load({})')
  await writeFile(join(pkg, 'cordis.patch.yml'), '- id: agent-hints')
  return dir
}
describe('installed server entry verification', () => {
  it('checks a fresh import rather than accepting package version and files alone', async () => {
    const dir = await fixture("import 'missing-agenthint-peer-fixture'; export const name='agent-hints'; export function apply(){}")
    const rows = await checkInstallation(dir)
    expect(rows.find((r: any) => r.name === 'server entry imports')).toMatchObject({ ok: false })
    expect(rows.find((r: any) => r.name === 'server entry imports').detail).toContain('missing-agenthint-peer-fixture')
  })
  it('accepts an importable entry and rejects an omitted profile bundle', async () => {
    const entry = "export const name='agent-hints'; export function apply(){}"
    expect((await checkInstallation(await fixture(entry))).every((r: any) => r.ok)).toBe(true)
    expect((await checkInstallation(await fixture(entry, false))).find((r: any) => r.name === 'profile bundle')).toMatchObject({ ok: false })
  })
  it('uses only an explicitly selected stock installation for runtime-supplied peers', async () => {
    const dir = await fixture("import '@deepseek-ai/dsh-llm'; export const name='agent-hints'; export function apply(){}")
    expect((await checkInstallation(dir)).find((r: any) => r.name === 'server entry imports')).toMatchObject({ ok: false })
    const installAnchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
    expect((await checkInstallation(dir, { installAnchor })).every((r: any) => r.ok)).toBe(true)
    const broken = await fixture("import 'missing-agenthint-peer-fixture'; export const name='agent-hints'; export function apply(){}")
    expect((await checkInstallation(broken, { installAnchor })).find((r: any) => r.name === 'server entry imports')).toMatchObject({ ok: false })
  })
})
