import { build } from 'esbuild'
import { mkdir, cp, writeFile } from 'node:fs/promises'
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
// tripo-cli is already a bundled CLI; keep its package metadata and assets.
await cp(join(root, 'node_modules/tripo-cli'), join(output, 'node_modules/tripo-cli'), { recursive: true })
await writeFile(join(output, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }))
console.log('Custom service and Tripo runtime built')
