import { build } from 'esbuild'
import { mkdir, cp, writeFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'src-tauri', 'custom-runtime')
await mkdir(output, { recursive: true })
await build({
  absWorkingDir: root, entryPoints: ['src/custom/service.ts'], outfile: join(output, 'service.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  define: { 'import.meta.url': '__customImportMetaUrl' },
  banner: { js: "var __customImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  alias: { electron: join(root, 'src/custom/electronAdapter.ts'), '@shared': join(root, 'src/shared') }
})
await mkdir(join(output, 'out/main'), { recursive: true })
await build({ absWorkingDir: root, entryPoints: ['src/main/tripoMcpBridge.ts'], outfile: join(output, 'out/main/tripoMcpBridge.js'), bundle: true, platform: 'node', format: 'cjs', target: 'node22' })
// Keep the official CLI unchanged and ship its complete production dependency
// tree. A checkout can hide missing packages through parent node_modules lookup.
async function packageRoot(name, from) {
  const req = createRequire(join(from, 'package.json'))
  let dir = dirname(req.resolve(name))
  for (;;) {
    try { if (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).name === name) return dir } catch {}
    const parent = dirname(dir)
    if (parent === dir) throw new Error('Could not resolve production package ' + name)
    dir = parent
  }
}
async function copyPackage(source, destination, ancestors = new Set()) {
  if (ancestors.has(source)) throw new Error('Unexpected circular production dependency')
  await cp(source, destination, { recursive: true, filter: (file) => file !== join(source, 'node_modules') })
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const next = new Set([...ancestors, source])
  for (const name of Object.keys(manifest.dependencies || {})) {
    await copyPackage(await packageRoot(name, source), join(destination, 'node_modules', name), next)
  }
}
await copyPackage(join(root, 'node_modules/tripo-cli'), join(output, 'node_modules/tripo-cli'))
await writeFile(join(output, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }))
console.log('Custom service and Tripo runtime built')
