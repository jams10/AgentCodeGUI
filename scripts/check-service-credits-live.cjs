// Launched with the bundled Electron. No BrowserWindow or model turn is created.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const dir = path.resolve(__dirname, '../.dev-home/credit-verification')
app.setPath('userData', path.join(dir, 'live-userdata'))
app.whenReady().then(async () => {
  try {
    const { getServiceCredits } = require(path.join(dir, 'backend.cjs'))
    const values = await Promise.all(['tripo', 'comfy-cloud'].map(service => getServiceCredits(service, true)))
    for (const value of values) console.log(JSON.stringify(value))
    fs.writeFileSync(path.join(dir, 'live-results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), values, generatedAssets: 0 }, null, 2))
    app.exit(values.every(value => value.state === 'ready' && value.balance != null) ? 0 : 1)
  } catch { console.error('Live service balance verification failed'); app.exit(1) }
})
