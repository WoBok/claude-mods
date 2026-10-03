export type TurnTiming = { ms: number; endedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'reply-timer': { seq: number }
  }
}
