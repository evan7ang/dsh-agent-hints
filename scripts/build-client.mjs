import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
const { name } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
await build({
  entryPoints: ['src/client/index.ts'], outfile: 'lib/client.js',
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2024',
  external: ['react'],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
})
