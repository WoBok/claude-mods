import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TurnTiming } from '../types'

// Bumped once per finished turn: the only value a drawing subscribes to, so a write redraws just the replies still waiting
const seq = atom({ plugin: 'reply-timer', key: 'seq' } as const, 0)

// Every finished turn's timing under its reply's message id, in $.store so it outlives a restart.
// One entry is a few dozen bytes: the cap keeps the file far below the store's 4 MiB
const STORE_KEY = 'byMessage'
const MAX_TURNS = 5000
type StoredTiming = [messageId: string, ms: number, endedAt: number]

// djb2 and FNV-1a over the trimmed text: matches the answer to one of this turn's own blocks
const keyOf = (text: string) => {
  let djb = 5381
  let fnv = 0x811c9dc5
  const s = text.trim()
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    djb = ((djb << 5) + djb + c) | 0
    fnv = Math.imul(fnv ^ c, 0x01000193)
  }
  return `${s.length}:${(djb >>> 0).toString(36)}${(fnv >>> 0).toString(36)}`
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

// The stored timings, in this module's memory; drawing reads them here, never through $.store
const byId = new Map<string, TurnTiming>()
// Timings matched to a reply but not yet written: a render may not write, the next turn's end or the session's does
const unsaved = new Set<string>()
let loading: Promise<void> | undefined

async function readStored($: EngineInterface): Promise<StoredTiming[]> {
  const stored = await $.store.get(STORE_KEY)
  return Array.isArray(stored) ? (stored as StoredTiming[]) : []
}

// Loaded on first need, so a reply drawn before session.start still waits for it
function ensureLoaded($: EngineInterface): Promise<void> {
  loading ??= (async () => {
    for (const [id, ms, endedAt] of await readStored($)) {
      byId.set(id, { ms, endedAt })
    }
  })()
  return loading
}

// Re-reads before writing so other open sessions' turns are kept, then appends ours last
async function persist($: EngineInterface): Promise<void> {
  if (unsaved.size === 0) {
    return
  }
  const merged = (await readStored($)).filter(([id]) => !unsaved.has(id))
  for (const id of unsaved) {
    const timing = byId.get(id)
    if (timing) {
      merged.push([id, timing.ms, timing.endedAt])
    }
  }
  unsaved.clear()
  await $.store.set(STORE_KEY, merged.slice(-MAX_TURNS))
}

export const register: Register = on => {
  // Each reply block bound once: message id -> its text length when decided, and its label or null
  const bound = new Map<string, { length: number; label: string | null }>()
  // The blocks first drawn while the running turn streamed: message id -> latest text
  const turnBlocks = new Map<string, string>()
  // A finished turn whose block was not drawn while it ran: the first new block with its text claims it
  let pending: { key: string; timing: TurnTiming } | null = null
  let isTurnRunning = false

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    turnBlocks.clear()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Main loop only; a subagent's turns are not the person's
    if (e.agentId) {
      return next(e)
    }
    isTurnRunning = false
    let id: string | undefined
    if (e.answer.trim()) {
      await ensureLoaded($)
      const key = keyOf(e.answer)
      const timing: TurnTiming = { ms: e.durationMs, endedAt: await $.clock.now() }
      // Only this turn's own blocks are compared, so an identical older reply is never mistaken for it
      id = [...turnBlocks].reverse().find(([, text]) => keyOf(text) === key)?.[0]
      if (id) {
        byId.set(id, timing)
        unsaved.add(id)
      } else {
        pending = { key, timing }
      }
    }
    // This turn's blocks are decided now, so a late redraw is never taken for the next turn's own
    for (const [blockId, text] of turnBlocks) {
      const timing = byId.get(blockId)
      bound.set(blockId, { length: text.length, label: blockId === id && timing ? labelOf(timing) : null })
    }
    turnBlocks.clear()
    await persist($)
    // Redraws only the blocks drawn while the turn ran, the ones that read seq
    await update($, seq, n => n + 1)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await persist($)
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const id = e.requestId
    const { text } = e.props
    let entry = bound.get(id)

    if (!entry || entry.length !== text.length) {
      if (isTurnRunning) {
        // A block already decided before this turn is an older reply; anything else is this turn's own
        if (!entry) {
          turnBlocks.set(id, text)
        }
        // Still streaming: nothing can match before the turn ends; wait on seq, no hashing per chunk
        await read($, seq)
        return next(e)
      }
      await ensureLoaded($)
      let timing = byId.get(id)
      if (!timing && pending && !entry && keyOf(text) === pending.key) {
        timing = pending.timing
        pending = null
        byId.set(id, timing)
        unsaved.add(id)
      }
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
