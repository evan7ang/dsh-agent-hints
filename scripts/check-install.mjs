#!/usr/bin/env node
/** Read-only verification. Import the installed server entry without starting DSH. */
import { readFile, realpath } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = 'dsh-agent-hints'

export async function checkInstallation(profileDir, options = {}) {
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok, detail })
  try {
    const profile = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    check('profile bundle', profile.dsh?.profile?.bundles?.includes(PLUGIN) === true,
      'The installed package must also be listed in dsh.profile.bundles')
    const packageDir = await realpath(join(profileDir, 'node_modules', PLUGIN))
    const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
    check('package identity', pkg.name === PLUGIN, `version=${pkg.version}`)
    // Native import is deliberately strict. Stock DSH may supply peers through
    // its installation resolver instead of profile-local node_modules. An
    // explicit running-install anchor enables that same read-only resolver;
    // never borrow peers silently from this verifier's development checkout.
    const entry = pathToFileURL(join(packageDir, pkg.main ?? 'lib/types/index.js')).href
    const program = `
      import {createRequire} from 'node:module';
      import {pathToFileURL} from 'node:url';
      const [entry, profileDir, anchor] = process.argv.slice(1);
      let ctx;
      try {
        if (anchor) {
          const require = createRequire(anchor);
          const {Context} = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
          const {createRuntimeResolution, PluginPackages} = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
          const resolution = await createRuntimeResolution({installAnchor:anchor,
            profile:{dir:profileDir, layers:[], skippedBundles:[]}});
          ctx = new Context();
          await ctx.plugin(PluginPackages, {resolution});
        }
        const m = await import(entry);
        if (m.name!=='agent-hints'||typeof m.apply!=='function') throw Error('Invalid server entry');
      } finally { await ctx?.fiber.dispose(); }
    `
    const anchor = options.installAnchor === undefined ? '' : resolve(options.installAnchor)
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', program, entry, profileDir, anchor],
    { cwd: profileDir, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 })
    check('server entry imports', probe.status === 0 && probe.error === undefined,
      probe.status === 0 ? `Server import only (${anchor ? 'explicit stock DSH installation resolver' : 'native Node resolver'}); no inference or plugin activation`
        : String(probe.error?.message ?? probe.stderr).slice(0, 4000))
    const client = await readFile(join(packageDir, 'lib/client.js'), 'utf8')
    check('browser bundle present', client.includes('__ModuleLoader__'),
      'Presence only; live browser activation is a separate integration check')
    const patch = await readFile(join(packageDir, 'cordis.patch.yml'), 'utf8')
    check('route patch present', patch.includes('agent-hints'), 'cordis.patch.yml')
  } catch (error) {
    check('installed layout readable', false, String(error.message))
  }
  return checks
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const index = process.argv.indexOf('--profile-dir')
  if (index < 0 || !process.argv[index + 1]) {
    console.error('Usage: node scripts/check-install.mjs --profile-dir <absolute-profile-directory> [--dsh-install-anchor <running-dsh-package.json>]')
    process.exitCode = 2
  } else {
    const anchorIndex = process.argv.indexOf('--dsh-install-anchor')
    if (anchorIndex >= 0 && !process.argv[anchorIndex + 1]) {
      console.error('--dsh-install-anchor requires the running DSH installation package.json path')
      process.exitCode = 2
    } else {
      const checks = await checkInstallation(resolve(process.argv[index + 1]),
        anchorIndex < 0 ? {} : { installAnchor: process.argv[anchorIndex + 1] })
      for (const row of checks) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.name}: ${row.detail}`)
      process.exitCode = checks.every(row => row.ok) ? 0 : 1
    }
  }
}
