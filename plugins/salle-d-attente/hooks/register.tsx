import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Game } from '../types'

// Modern Claudefare (FPS multijoueur dans le navigateur) tourne dans un Chrome invisible ;
// bridge/bridge.mjs écrit ses images en PNG et reçoit nos entrées en HTTP local.
const GAME_URL = 'https://www.modernclaudefare.com/'
const PANE = 'salle-d-attente'
const PAGE_W = 640
const PAGE_H = 360
const LOOK_SPEED = 2.2

const isWorking = atom({ plugin: 'salle-d-attente', key: 'isWorking' } as const, false)
const isOff = atom({ plugin: 'salle-d-attente', key: 'isOff' } as const, false)
const isAzerty = atom({ plugin: 'salle-d-attente', key: 'isAzerty' } as const, false)
const game = atom({ plugin: 'salle-d-attente', key: 'game' } as const, { status: 'off', error: '', invite: '' } as Game)

let port = 0
let token = ''
let isRunning = false
let shouldStop = false
let frameFile = ''
let frameN = 0
let lastSeen = 0
let lastPos: { x: number; y: number } | null = null
let pageSize = { w: PAGE_W, h: PAGE_H }
let box = { cols: 0, rows: 0 }
let sentSize = ''
let isResizing = false

// Une cellule de terminal est environ deux fois plus haute que large.
const CELL_RATIO = 2.3
const MAX_PAGE_W = 820

// Donne à la page du jeu les proportions du panneau : l'image le remplit sans bandes ni coupe.
// Appelé depuis la boucle des images : un appel lancé pendant un dessin serait abandonné avec lui.
async function fitPage($: EngineInterface) {
  if (!port || !box.cols || isResizing) return
  const w = Math.min(MAX_PAGE_W, box.cols * 9)
  const h = Math.round((w * box.rows * CELL_RATIO) / box.cols)
  const key = `${w}x${h}`
  if (key === sentSize) return
  isResizing = true
  try {
    const r = await post($, [{ type: 'resize', w, h }])
    if (r) {
      sentSize = key
      pageSize = { w, h }
    }
  } finally {
    isResizing = false
  }
}

async function post($: EngineInterface, actions: unknown[]) {
  try {
    const r = await $.http.fetch(`http://127.0.0.1:${port}/${token}`, { method: 'POST', body: JSON.stringify(actions) })
    return r.ok
  } catch {
    return false
  }
}

// Si l'image n'a pas (encore) les proportions de la case, le terminal la centre avec des bandes :
// on ramène la position du pointeur sur l'image elle-même.
function toPage(x: number, y: number) {
  if (!box.cols) return { x, y }
  const boxAspect = box.cols / (box.rows * CELL_RATIO)
  const pageAspect = pageSize.w / pageSize.h
  if (pageAspect > boxAspect) {
    const shown = boxAspect / pageAspect
    return { x, y: (y - (1 - shown) / 2) / shown }
  }
  const shown = pageAspect / boxAspect
  return { x: (x - (1 - shown) / 2) / shown, y }
}

// ZQSD sur un clavier AZERTY = WASD pour le jeu.
const AZERTY: Record<string, string> = { z: 'w', q: 'a', w: 'z', a: 'q' }
const NAMED: Record<string, string> = { return: 'Enter', tab: 'Tab', backspace: 'Backspace', space: ' ' }
const ARROWS: Record<string, [number, number]> = { left: [-90, 0], right: [90, 0], up: [0, -50], down: [0, 50] }

async function setGame($: EngineInterface, patch: Partial<Game>) {
  await update($, game, g => ({ ...g, ...patch }))
}

// Le panneau affiche des images seulement dans un terminal qui sait le faire (Ghostty, kitty),
// et le pont a besoin de Google Chrome sur macOS. Sinon, le jeu s'ouvre dans le navigateur.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

async function canPlayInPane($: EngineInterface) {
  const surfaces = await $.session.surfaces()
  if (surfaces.length > 0 && !surfaces.includes('terminal')) return false
  try {
    await $.fs.stat(CHROME)
  } catch {
    return false
  }
  const { stdout } = await $.process.run(['/usr/bin/printenv'])
  const env = Object.fromEntries(stdout.split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  if (env.TMUX) return false
  return env.TERM_PROGRAM === 'ghostty' || env.TERM === 'xterm-kitty' || Boolean(env.KITTY_WINDOW_ID)
}

async function startGame($: EngineInterface, url = GAME_URL) {
  if (!isRunning && !(await canPlayInPane($))) {
    await $.process.run(['open', url])
    $.ui.toast('Ton terminal n’affiche pas d’images : le jeu s’ouvre dans le navigateur (Ghostty ou kitty pour le panneau).')
    return
  }
  await $.ui.open({ id: PANE, title: 'Modern Claudefare', columns: 72 })
  if (isRunning) return
  isRunning = true
  shouldStop = false
  frameFile = ''
  sentSize = ''
  pageSize = { w: PAGE_W, h: PAGE_H }
  await setGame($, { status: 'starting', error: '', invite: '' })
  const root = $.plugin.root
  // Le PATH de Claude Code n'a pas forcément Homebrew : on cherche node aux endroits habituels.
  let node = 'node'
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try {
      await $.fs.stat(candidate)
      node = candidate
      break
    } catch {}
  }
  const argv = [node, `${root}/bridge/bridge.mjs`, url, String(PAGE_W), String(PAGE_H)]
  let buffer = ''
  let errors = ''
  try {
    for await (const { stream, text } of $.process.spawn({ argv, env: { BRIDGE_FPS: '24' } })) {
      if (shouldStop) break
      if (stream === 'stderr') {
        errors = (errors + text).slice(-400)
        continue
      }
      buffer += text
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.port) {
          port = msg.port
          token = msg.token
        }
        if (msg.invite !== undefined) await setGame($, { invite: msg.invite })
        if (msg.frame) {
          const isFirst = frameFile === ''
          frameFile = msg.frame
          frameN = msg.n
          if (isFirst) {
            await setGame($, { status: 'on' })
          } else {
            void $.ui.blit({ requestId: PANE, key: 'view', source: { file: frameFile, format: 'png', generation: frameN } })
          }
          void fitPage($)
        }
      }
    }
  } catch (err) {
    errors = String(err)
  }
  isRunning = false
  port = 0
  token = ''
  const g = await read($, game)
  if (!shouldStop && g.status !== 'off') {
    await setGame($, { status: 'error', error: errors.trim() || 'Le jeu s’est arrêté (journal : ~/Library/Caches/salle-d-attente/bridge.log).' })
  } else {
    await setGame($, { status: 'off' })
  }
}

async function stopGame($: EngineInterface) {
  shouldStop = true
  await setGame($, { status: 'off' })
  await $.ui.close({ id: PANE })
}

async function forward($: EngineInterface, events: any[]) {
  if (!port) return
  const azerty = await read($, isAzerty)
  const actions: any[] = []
  for (const ev of events) {
    if (ev.id <= lastSeen) continue
    lastSeen = ev.id
    if (ev.t === 'enter' || ev.t === 'leave') {
      lastPos = null
    } else if (ev.t === 'move' || ev.t === 'down' || ev.t === 'up') {
      const at = toPage(ev.x, ev.y)
      if (ev.t === 'move' && lastPos) {
        const dx = Math.round((at.x - lastPos.x) * pageSize.w * LOOK_SPEED)
        const dy = Math.round((at.y - lastPos.y) * pageSize.h * LOOK_SPEED)
        if (dx || dy) actions.push({ type: 'look', dx, dy })
      }
      lastPos = at
      actions.push({ type: ev.t, x: at.x, y: at.y, button: ev.b })
    } else if (ev.t === 'key') {
      const k = String(ev.k)
      if (ARROWS[k]) {
        actions.push({ type: 'look', dx: ARROWS[k][0], dy: ARROWS[k][1] })
        continue
      }
      let key = NAMED[k] ?? k
      if (key.length !== 1 && !NAMED[k]) continue
      const lower = key.toLowerCase()
      if (key !== lower || ev.shift) actions.push({ type: 'key', key: 'Shift' })
      key = azerty ? (AZERTY[lower] ?? lower) : lower
      actions.push({ type: 'key', key })
    }
  }
  if (actions.length === 0) return
  await post($, actions)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Une partie d'un chargement précédent n'existe plus : on repart propre.
    await setGame($, { status: 'off', error: '', invite: '' })
    await $.command.register({
      name: 'jouer',
      description: 'Lance Modern Claudefare dans le panneau ; /jouer <lien d’invitation> pour rejoindre ; /jouer stop ; /jouer on|off',
    })
    return next(e)
  })

  on('command.run', { command: 'jouer' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      await update($, isOff, () => arg === 'off')
      return { text: `Phrase en bas ${arg === 'off' ? 'désactivée' : 'réactivée'}.` }
    }
    const invite = e.args.trim()
    if (invite.startsWith(GAME_URL)) {
      if (isRunning) {
        await post($, [{ type: 'goto', url: invite }])
      } else {
        void startGame($, invite)
      }
      return { text: 'Tu rejoins le salon de ton pote dans le panneau.' }
    }
    if (arg === 'stop') {
      await stopGame($)
      return { text: 'Partie arrêtée.' }
    }
    void startGame($)
    return { text: 'Modern Claudefare se lance dans le panneau.' }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, isWorking, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, isWorking, () => false)
    if (isRunning) $.ui.toast('Claude a fini, ta partie continue.')
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      shouldStop = true
      await setGame($, { status: 'off' })
    }
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'pad') return next(e)
    const data = e.data as { events?: any[] }
    await forward($, data?.events ?? [])
    return {}
  })

  // La phrase en bas, pendant que Claude travaille.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const working = await read($, isWorking)
    if (e.props.hasSurvey || !working || (await read($, isOff))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const g = await read($, game)
    return (
      <Box gap={1}>
        <Text dimColor>Claude bosse, une partie en attendant ?</Text>
        <Button
          key="play"
          label={g.status === 'on' ? '🎮 Reprendre la partie' : '🎮 Modern Claudefare'}
          onPress={() => void startGame($)}
        />
      </Box>
    )
  })

  // Le vrai jeu, dans le panneau.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Client, Image, Text } = $.ui.resolve(e) as any
    const g = await read($, game)
    const azerty = await read($, isAzerty)
    const header = (
      <Box gap={1}>
        <Button key="quit" label="Quitter" onPress={() => void stopGame($)} />
        <Button key="layout" label={azerty ? 'AZERTY' : 'QWERTY'} onPress={() => update($, isAzerty, v => !v)} />
        {g.invite && (
          <Button
            key="invite"
            label="Copier l’invitation"
            onPress={() => {
              void $.ui.copy({ text: g.invite, surface: e.surface })
              $.ui.toast('Lien d’invitation copié : ton pote le colle après /jouer')
            }}
          />
        )}
        <Text dimColor wrap="truncate">clic = jouer · Échap = clavier</Text>
      </Box>
    )

    if (g.status === 'error') {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text color="red">{g.error}</Text>
          <Button key="retry" label="Relancer" onPress={() => void startGame($)} />
        </Box>
      )
    }
    if (g.status !== 'on' || !frameFile) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text>Lancement de Modern Claudefare…</Text>
          {g.status === 'off' && <Button key="start" label="Lancer" onPress={() => void startGame($)} />}
        </Box>
      )
    }

    // Tout le corps du panneau, moins la ligne des boutons.
    const cols = Math.max(10, e.props.bodyColumns ?? 72)
    const rows = Math.max(4, (e.props.scroll?.bodyRows ?? 24) - 1)
    box = { cols, rows }

    return (
      <Box flexDirection="column">
        {header}
        <Box width={cols} height={rows}>
          <Image
            key="view"
            source={{ file: frameFile, format: 'png', generation: frameN }}
            columns={cols}
            rows={rows}
            alt="Modern Claudefare"
          />
          <Box position="absolute" top={0} left={0} width={cols} height={rows}>
            <Client key="pad" module="./controls.tsx" width={cols} height={rows} />
          </Box>
        </Box>
      </Box>
    )
  })
}
