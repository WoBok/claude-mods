import type { Register, SessionRateLimit } from 'claude-code'

const findLimit = (limits: SessionRateLimit[], kind: string) =>
  limits.find(limit => limit.kind === kind)

// Hours until a window resets, to one decimal: 4.9h, 0.3h; nothing once it has passed
const hoursLeft = (resetsAt: string, now: number) => {
  const ms = Date.parse(resetsAt) - now
  return ms > 0 ? `${(ms / 3_600_000).toFixed(1)}h` : undefined
}

// The last reading any session saw, shown until this session gets its own
const CACHE_KEY = 'rateLimits'
let cachedLimits: SessionRateLimit[] = []

// The usage endpoint the app's own meter reads; the host attaches the credential
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

// The endpoint answers { five_hour: { utilization, resets_at }, seven_day: { ... } }
const parseUsage = (body: unknown): SessionRateLimit[] => {
  const limits: SessionRateLimit[] = []
  if (!body || typeof body !== 'object') {
    return limits
  }
  for (const kind of ['five_hour', 'seven_day']) {
    const window = (body as Record<string, unknown>)[kind] as Record<string, unknown> | null | undefined
    if (window && typeof window.utilization === 'number') {
      const limit: SessionRateLimit = { kind, percentUsed: window.utilization }
      if (typeof window.resets_at === 'string') {
        limit.resetsAt = window.resets_at
      }
      limits.push(limit)
    }
  }
  return limits
}

// A cached window whose reset has passed starts over at zero, its next reset unknown
const fresh = (limits: SessionRateLimit[], now: number): SessionRateLimit[] =>
  limits.map(limit =>
    limit.resetsAt && Date.parse(limit.resetsAt) <= now ? { kind: limit.kind, percentUsed: 0 } : limit,
  )

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      const stored = await $.store.get(CACHE_KEY)
      if (Array.isArray(stored)) {
        cachedLimits = stored as SessionRateLimit[]
      }
    } catch {
      // No cache yet
    }
    $.ui.invalidate('ui.render')

    // The hours left count down between replies
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))

    // Read the limits before the first reply carries any; the secret stays with the host.
    // Not awaited, so the session starts without waiting on the network
    void (async () => {
      try {
        const auth = await $.session.authorize()
        if (auth) {
          const response = await $.http.fetch(USAGE_URL, {
            auth: auth.handle,
            headers: { 'anthropic-beta': 'oauth-2025-04-20' },
          })
          const limits = response.ok ? parseUsage(JSON.parse(response.text)) : []
          if (limits.length > 0) {
            cachedLimits = limits
            await $.store.set(CACHE_KEY, limits)
            $.ui.invalidate('ui.render')
          }
        }
      } catch {
        // Keep the cached reading
      }
    })()

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0 && e.changed.includes('rateLimits')) {
      cachedLimits = e.rateLimits
      try {
        await $.store.set(CACHE_KEY, e.rateLimits)
      } catch {
        // The live reading still shows
      }
    }
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // A compaction clears the context reading; redraw so the estimate replaces the old figure
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    $.ui.invalidate('ui.render')
    return result
  })

  // The desktop footer strip draws this site only from a tree of Text, at most 24ch wide
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const now = Date.now()
    const usage = await $.session.usage()
    const { context } = usage
    const rateLimits = usage.rateLimits.length > 0 ? usage.rateLimits : fresh(cachedLimits, now)
    const parts: string[] = []

    // No reading until the first reply after a start or a compaction; estimate it locally as /context does
    const contextPercent = context.percent ?? (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.percentage
    if (contextPercent !== undefined) {
      parts.push(`⛁ ${contextPercent}%`)
    }

    const fiveHour = findLimit(rateLimits, 'five_hour')
    if (fiveHour) {
      // The stopwatch, asked for in its text style (U+FE0E) so it is never the colour emoji
      let text = `⏱\uFE0E ${Math.round(fiveHour.percentUsed)}%`
      const left = fiveHour.resetsAt ? hoursLeft(fiveHour.resetsAt, now) : undefined
      if (left) {
        text += ` ${left}`
      }
      parts.push(text)
    }

    const weekly = findLimit(rateLimits, 'seven_day')
    if (weekly) {
      parts.push(`▦ ${Math.round(weekly.percentUsed)}%`)
    }

    if (parts.length === 0) {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)
    const modes = e.props.modes.length > 0 ? ` & ${e.props.modes.join(' & ')}` : ''

    // The theme's primary ink, as the model picker beside it
    return Text({ color: 'text', children: [parts.join(' | ') + modes] })
  })
}
