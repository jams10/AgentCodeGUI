'use strict'
// Self-heal for Electron's binary. On this machine the electron postinstall
// silently fails to extract, leaving node_modules/electron without a binary
// (=> electron-vite "Electron uninstall"). This downloads the matching artifact
// and extracts it — using PowerShell on Windows because node's extract-zip
// fails silently here. Idempotent: skips when already installed.
const path = require('node:path')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { downloadArtifact } = require('@electron/get')

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron')
const { version } = require(path.join(electronDir, 'package.json'))
const distDir = path.join(electronDir, 'dist')
const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron'

function psQuote(p) {
  return "'" + String(p).replace(/'/g, "''") + "'"
}

async function main() {
  const exePath = path.join(distDir, exeName)
  if (fs.existsSync(exePath) && fs.existsSync(path.join(electronDir, 'path.txt'))) {
    console.log('[fetch-electron] electron', version, 'already installed.')
    return
  }
  console.log('[fetch-electron] fetching electron', version, '…')
  const zip = await downloadArtifact({ version, artifactName: 'electron', platform: process.platform, arch: process.arch })
  fs.rmSync(distDir, { recursive: true, force: true })
  fs.mkdirSync(distDir, { recursive: true })
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(distDir)} -Force`],
      { stdio: 'inherit' }
    )
  } else {
    await require('extract-zip')(zip, { dir: distDir })
  }
  fs.writeFileSync(path.join(electronDir, 'path.txt'), exeName)
  console.log('[fetch-electron] done — electron.exe present:', fs.existsSync(exePath))
}

main().catch((e) => {
  console.error('[fetch-electron] FAILED:', e && e.stack ? e.stack : e)
  process.exit(1)
})
