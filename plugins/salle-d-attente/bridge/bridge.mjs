// Pont entre un Chrome invisible et le panneau du mod : images PNG sur disque, entrées par HTTP local.
// Usage : node bridge.mjs <url> [largeur] [hauteur]
// Fichiers de travail (images, profil Chrome, journal) : ~/Library/Caches/salle-d-attente,
// ou le dossier donné dans BRIDGE_DIR. Jamais dans le dossier du plugin, qui peut être en lecture seule.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [url, w = '640', h = '360'] = process.argv.slice(2)
const dir = process.env.BRIDGE_DIR || join(homedir(), 'Library', 'Caches', 'salle-d-attente')
// Code tiré au hasard à chaque lancement : sans lui, le serveur local refuse tout.
// Sinon n'importe quelle page ouverte dans un navigateur pourrait envoyer des requêtes au pont.
const TOKEN = randomBytes(16).toString('hex')
let W = Number(w)
let H = Number(h)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
mkdirSync(dir, { recursive: true })
if (!existsSync(CHROME)) {
  process.stderr.write(`Google Chrome est introuvable (${CHROME}).\n`)
  process.exit(2)
}
const log = line => { try { appendFileSync(join(dir, 'bridge.log'), `${new Date().toISOString()} ${line}
`) } catch {} }
process.on('uncaughtException', e => { log(`erreur : ${e.stack ?? e}`); process.exit(1) })
process.on('unhandledRejection', e => { log(`erreur : ${e?.stack ?? e}`); process.exit(1) })

// Un profil neuf à chaque lancement : un Chrome resté en vie ne peut pas bloquer le suivant.
for (const name of readdirSync(dir)) {
  if (name.startsWith('profile')) { try { rmSync(join(dir, name), { recursive: true, force: true }) } catch {} }
}
const profile = join(dir, `profile-${process.pid}`)
mkdirSync(profile, { recursive: true })
log(`lancement ${url} ${W}x${H}`)

const say = obj => process.stdout.write(JSON.stringify(obj) + '\n')

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, '--autoplay-policy=no-user-gesture-required',
  '--no-first-run', '--no-default-browser-check', '--enable-gpu', '--ignore-gpu-blocklist',
  '--use-fake-ui-for-media-stream', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

const quit = () => { log('arrêt'); try { chrome.kill() } catch {} try { rmSync(profile, { recursive: true, force: true }) } catch {} process.exit(0) }
process.on('SIGTERM', quit)
process.on('SIGINT', quit)
// Quand Claude Code s'arrête, on emporte Chrome avec nous.
if (!process.env.BRIDGE_DETACHED) {
  const parent = process.ppid
  setInterval(() => { try { process.kill(parent, 0) } catch { quit() } }, 2000)
}
chrome.on('exit', code => { log(`Chrome s'est arrêté (${code})`); process.stderr.write(`Chrome s'est arrêté (${code})
`); process.exit(1) })

const port = await new Promise((resolve, reject) => {
  let err = ''
  chrome.stderr.on('data', d => {
    err += d
    const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//)
    if (m) resolve(Number(m[1]))
  })
  setTimeout(() => reject(new Error('Chrome ne répond pas')), 20000)
})

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find(p => p.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))

let nextId = 1
const waiting = new Map()
const send = (method, params = {}) => new Promise(resolve => {
  const id = nextId++
  waiting.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})

// Le jeu demande le verrouillage du pointeur ; on le simule pour piloter la visée nous-mêmes.
const LOCK = `(() => {
  let locked = null
  Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => locked, configurable: true })
  Element.prototype.requestPointerLock = function () {
    locked = this
    setTimeout(() => document.dispatchEvent(new Event('pointerlockchange')), 0)
    return Promise.resolve()
  }
  Document.prototype.exitPointerLock = function () {
    locked = null
    setTimeout(() => document.dispatchEvent(new Event('pointerlockchange')), 0)
  }
  window.__look = (dx, dy) => {
    const t = locked || document
    t.dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY: dy, bubbles: true }))
  }
})()`

let frame = 0
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg.result)
    waiting.delete(msg.id)
    return
  }
})

function writeFrame(data) {
  frame += 1
  const file = join(dir, `frame-${frame % 4}.png`)
  writeFileSync(file + '.tmp', Buffer.from(data, 'base64'))
  renameSync(file + '.tmp', file)
  say({ frame: file, n: frame })
}

await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: LOCK })
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url })
await send('Page.bringToFront')

// Le screencast reste muet en mode sans tête : on capture nous-mêmes, aussi vite que Chrome suit.
const FPS = Number(process.env.BRIDGE_FPS ?? 20)
;const capture = async () => {
  for (;;) {
    const started = Date.now()
    const shot = await send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true })
    if (shot?.data) {
      writeFrame(shot.data)
      await keepSize(shot.data)
    }
    await new Promise(r => setTimeout(r, Math.max(0, 2000 / FPS - (Date.now() - started))))
  }
}
// Chrome perd parfois la taille demandée (une navigation, une demande arrivée pendant le chargement) :
// on lit la largeur et la hauteur dans l'en-tête PNG de chaque image et on la réapplique au besoin.
let lastFix = 0
async function keepSize(data) {
  const head = Buffer.from(data.slice(0, 44), 'base64')
  const pw = head.readUInt32BE(16)
  const ph = head.readUInt32BE(20)
  if ((pw === W && ph === H) || Date.now() - lastFix < 500) return
  lastFix = Date.now()
  log(`taille perdue (${pw}x${ph}), on remet ${W}x${H}`)
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
}

// Deux captures en vol à la fois : Chrome encode l'une pendant qu'on écrit l'autre.
capture()
setTimeout(capture, 1000 / FPS)

// Lien d'invitation du salon : le jeu le copie dans le presse-papiers de ce Chrome invisible,
// qui n'est pas celui de la personne ; on le lit dans la page et on le remonte au mod.
let invite = ''
setInterval(async () => {
  const r = await send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('input')].map(i => i.value).find(v => v.includes('/invite/')) || ''`,
    returnByValue: true,
  })
  const found = r?.result?.value ?? ''
  if (found && found !== invite) {
    invite = found
    say({ invite })
  }
}, 1500)

// Touches : un terminal n'envoie que des appuis (et leurs répétitions), jamais le relâchement.
// On tient la touche enfoncée et on la relâche quand les répétitions s'arrêtent.
const held = new Map()
const KEY_CODES = { ' ': ['Space', 32], Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27],
  Shift: ['ShiftLeft', 16], Control: ['ControlLeft', 17], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], Backspace: ['Backspace', 8] }
function codeFor(key) {
  if (KEY_CODES[key]) return KEY_CODES[key]
  if (/^[a-z]$/i.test(key)) return [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)]
  if (/^[0-9]$/.test(key)) return [`Digit${key}`, key.charCodeAt(0)]
  return [key, 0]
}
async function key(k, holdMs) {
  const [code, vk] = codeFor(k)
  const text = k.length === 1 ? k : undefined
  const prev = held.get(code)
  if (prev) {
    clearTimeout(prev)
  } else {
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, text, windowsVirtualKeyCode: vk })
  }
  held.set(code, setTimeout(() => {
    held.delete(code)
    send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
  }, prev ? 140 : holdMs))
}

let buttons = 0
async function mouse(type, x, y, button) {
  const bit = { left: 1, right: 2, middle: 4 }[button] ?? 0
  if (type === 'mousePressed') buttons |= bit
  if (type === 'mouseReleased') buttons &= ~bit
  await send('Input.dispatchMouseEvent', { type, x, y, button: button ?? 'none', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== `/${TOKEN}`) {
    res.statusCode = 403
    res.end()
    req.resume()
    return
  }
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', async () => {
    try {
      for (const a of JSON.parse(body || '[]')) {
        if (a.type === 'key') await key(a.key, a.holdMs ?? 520)
        if (a.type === 'look') await send('Runtime.evaluate', { expression: `window.__look && window.__look(${Number(a.dx)}, ${Number(a.dy)})` })
        if (a.type === 'down' || a.type === 'up' || a.type === 'move') {
          const t = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }[a.type]
          await mouse(t, a.x * W, a.y * H, a.button)
        }
        if (a.type === 'goto' && typeof a.url === 'string' && a.url.startsWith('https://www.modernclaudefare.com/')) {
          await send('Page.navigate', { url: a.url })
        }
        if (a.type === 'resize' && a.w > 0 && a.h > 0) {
          log(`taille ${a.w}x${a.h}`)
          W = Math.round(a.w)
          H = Math.round(a.h)
          await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
        }
      }
      res.end('ok')
    } catch (e) {
      res.statusCode = 500
      res.end(String(e))
    }
  })
})
server.listen(0, '127.0.0.1', () => { log(`prêt, port ${server.address().port}`); say({ port: server.address().port, token: TOKEN }) })
