export type Game = {
  status: 'off' | 'starting' | 'on' | 'error'
  error: string
  invite: string
}

declare module 'claude-code' {
  interface PluginState {
    'salle-d-attente': { isWorking: boolean; isOff: boolean; game: Game; isAzerty: boolean }
  }
}
