export type SaverAsk = { kind: string; percent: number; resetsAt?: string } | null
export type SaverResume = { file: string; savedAt: number } | null

declare module 'claude-code' {
  interface PluginState {
    'token-saver': { ask: SaverAsk; resume: SaverResume }
  }
}
