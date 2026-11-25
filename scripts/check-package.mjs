import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { posix } from 'node:path'
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
assert.equal(lock.version, pkg.version, 'lockfile version mismatch')
assert.equal(lock.packages[''].version, pkg.version, 'lockfile package version mismatch')
for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines']) {
  assert.deepEqual(lock.packages[''][section], pkg[section], `lockfile ${section} mismatch`)
}
const npm = process.env.npm_execpath
assert.ok(npm, 'Run this check through npm run check')
const pack = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }))[0]
const files = new Set(pack.files.map(file => file.path))
for (const path of ['lib/types/index.js', 'lib/types/index.d.ts', 'lib/types/chat-adapter.js', 'lib/types/adapter.js', 'lib/client.js',
  'lib/types/trace.js', 'lib/types/trace-record.d.ts', 'docs/trace.md',
  'lib/types/client/index.d.ts', 'cordis.patch.yml', 'scripts/check-install.mjs', 'docs/transport.md', 'docs/endpoint-inheritance.md', 'docs/reliability.md']) assert.ok(files.has(path), `Missing packaged asset: ${path}`)
for (const path of ['README.md', 'README.zh.md', 'docs/transport.md', 'docs/endpoint-inheritance.md', 'docs/reliability.md', 'docs/trace.md']) {
  const content = await readFile(path, 'utf8')
  for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
    const link = match[1]
    if (/^(https?:|#)/.test(link)) continue
    const target = posix.normalize(posix.join(posix.dirname(path), link.split('#')[0]))
    await access(new URL(target, pathToFileURL(process.cwd() + '/')))
    assert.ok(files.has(target), `Documentation link missing from package: ${target}`)
  }
}
console.log(`Package ${pkg.version}: ${files.size} files, exports, current docs and lock metadata verified`)
