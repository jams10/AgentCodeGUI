// Compatibility boundary for the fork's existing service modules. No Electron
// process is launched: cryptography uses ccg-store's Electron-compatible DPAPI.
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

function crypt(operation: string, input: string): string {
  const exe = process.env.CCG_CUSTOM_EXE
  if (!exe) throw new Error('Native credential helper is unavailable')
  const result = spawnSync(exe, ['--custom-crypto', operation], {
    input, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024
  })
  if (result.status !== 0 || result.error) throw new Error('Native credential operation failed')
  return result.stdout
}
export const safeStorage = {
  isEncryptionAvailable: () => !!process.env.CCG_CUSTOM_EXE && process.platform === 'win32',
  encryptString: (value: string) => Buffer.from(crypt('encrypt', value), 'base64'),
  decryptString: (value: Buffer) => crypt('decrypt', value.toString('base64'))
}
export const app = {
  isPackaged: false,
  getAppPath: () => process.env.CCG_CUSTOM_ROOT || process.cwd(),
  getPath: (name: string) => name === 'home' ? os.homedir() : process.env.CCG_HOME || path.join(os.homedir(), '.agentcodegui'),
  getLocale: () => 'ko',
  getName: () => 'AgentCodeGUI3'
}
function launch(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
export const shell = {
  openExternal: async (url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Unsupported external URL')
    await launch('rundll32.exe', ['url.dll,FileProtocolHandler', url])
  },
  openPath: async (folder: string) => {
    await launch('explorer.exe', [folder])
    return ''
  }
}
