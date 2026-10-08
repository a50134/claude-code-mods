export type FinderQuery = string

declare module 'claude-code' {
  interface PluginState {
    'cmd-finder': { query: FinderQuery }
  }
}
