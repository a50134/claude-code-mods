export type PanelTick = number

declare module 'claude-code' {
  interface PluginState {
    'projects-token-panel': { tick: PanelTick; closed: boolean }
  }
}
