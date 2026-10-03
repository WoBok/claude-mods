import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { TurnTiming } from '../types'

// Every finished turn's timing, keyed by its final reply's text; kept for reloads, never read while drawing
const timings = atom({ plugin: 'reply-timer', key: 'timings' } as const, {})
// Bumped once per finished turn: the only value a drawing subscribes to, so a write redraws just the replies still waiting
const seq = atom({ plugin: 'reply-timer', key: 'seq' } as const, 0)

// Plenty for a long chat; one entry is a few dozen bytes and lookups stay O(1)
const MAX_TURNS = 1000

// djb2 over the trimmed text: the reply block and turn.complete's answer meet on it
const keyOf = (text: string) => {
  let hash = 5381
  const s = text.trim()
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0
  }
  return `${s.length}:${hash >>> 0}`
}

// 3s, 1m 4s, 1h 2m
const formatDuration = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

const pad = (n: number) => String(n).padStart(2, '0')
const formatClock = (at: number) => {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const labelOf = (timing: TurnTiming) => `${formatDuration(timing.ms)} · ${formatClock(timing.endedAt)}`

// The desktop footer's own look ("2 minutes ago"): 13px system font, muted gray.
// Inset to the reply's text column, and set a paragraph's gap below the last line
const FOOTER_INSET = 4
const FOOTER_HEIGHT = 34
const FOOTER_BASELINE = 26
const footerWidth = (label: string) => FOOTER_INSET + 4 + label.length * 8
const footerSvg = (label: string) => {
  const width = footerWidth(label)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${FOOTER_HEIGHT}" viewBox="0 0 ${width} ${FOOTER_HEIGHT}">
<style>
text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:13px;fill:#8F8D87}
@media (prefers-color-scheme: dark){text{fill:#9C9A94}}
</style>
<text x="${FOOTER_INSET}" y="${FOOTER_BASELINE}" xml:space="preserve">${label}</text>
</svg>`
}

export const register: Register = on => {
  // The table, in this module's memory; drawing reads it here, never through $.state
  const byKey = new Map<string, TurnTiming>()
  // Each reply block bound once: message id -> its text length when decided, and its label or null
  const bound = new Map<string, { length: number; label: string | null }>()
  let isTurnRunning = false
  let loaded: Promise<void> = Promise.resolve()

  on('session.start', async ($, e, next) => {
    loaded = (async () => {
      for (const [key, timing] of Object.entries(await read($, timings))) {
        byKey.set(key, timing)
      }
    })()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Main loop only; a subagent's turns are not the person's
    if (e.agentId) {
      return next(e)
    }
    isTurnRunning = false
    if (e.answer.trim()) {
      byKey.set(keyOf(e.answer), { ms: e.durationMs, endedAt: await $.clock.now() })
      while (byKey.size > MAX_TURNS) {
        byKey.delete(byKey.keys().next().value as string)
      }
      await update($, timings, () => Object.fromEntries(byKey))
    }
    // Redraws only the blocks drawn while the turn ran, the ones that read seq
    await update($, seq, n => n + 1)
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const id = e.requestId
    const { text } = e.props
    let entry = bound.get(id)

    if (!entry || entry.length !== text.length) {
      if (isTurnRunning) {
        // Still streaming: nothing can match before the turn ends; wait on seq, no hashing per chunk
        await read($, seq)
        return next(e)
      }
      await loaded
      const timing = byKey.get(keyOf(text))
      entry = { length: text.length, label: timing ? labelOf(timing) : null }
      bound.set(id, entry)
    }

    if (!entry.label) {
      return next(e)
    }
    const reply = await next(e)

    if (e.surface === 'desktop') {
      const { Box, Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {reply}
          <Svg source={footerSvg(entry.label)} alt={entry.label} width={footerWidth(entry.label)} height={FOOTER_HEIGHT} />
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {reply}
        <Text dimColor>{entry.label}</Text>
      </Box>
    )
  })
}
