import type { ClientModule } from 'claude-code'

// Posé sur l'image du jeu : capte la souris et le clavier et les envoie au module de hooks.
// Un post par image au plus, et un post plus récent remplace celui pas encore livré :
// on envoie donc toujours les derniers événements numérotés, le module trie ce qu'il a déjà vu.
type Ev = { id: number; t: string; x?: number; y?: number; b?: string; k?: string; shift?: boolean }

let log: Ev[] = []
let nextId = 1

const Controls: ClientModule = (_props, surface) => {
  const push = (ev: Omit<Ev, 'id'>) => {
    log = [...log, { ...ev, id: nextId++ }].slice(-80)
    surface.post({ events: log })
  }
  const cols = Math.max(1, surface.columns)
  const rows = Math.max(1, surface.rows)

  surface.onPointer(e => {
    if (e.type === 'enter' || e.type === 'leave') return push({ t: e.type })
    const x = (e.fine?.x ?? e.x + 0.5) / cols
    const y = (e.fine?.y ?? e.y + 0.5) / rows
    push({ t: e.type, x, y, b: e.button })
  })
  surface.onKey(e => push({ t: 'key', k: e.key, shift: e.shift }))

  const { Box } = surface.elements
  return <Box width={surface.columns} height={surface.rows} />
}

export default Controls
