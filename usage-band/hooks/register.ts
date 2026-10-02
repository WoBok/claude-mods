import type { Register, SessionRateLimit } from 'claude-code'

// Minutes east of UTC, read from the host once (the module may run in UTC)
let offsetMinutes = -new Date().getTimezoneOffset()

const pad = (n: number) => String(n).padStart(2, '0')

// Shift a timestamp into local wall-clock time, read back with the UTC getters
const local = (ms: number) => new Date(ms + offsetMinutes * 60_000)

const timeOf = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`

const findLimit = (limits: SessionRateLimit[], kind: string) =>
  limits.find(limit => limit.kind === kind)

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
      const { exitCode, stdout } = await $.process.run(['date', '+%z'], { timeoutMs: 3000 })
      const match = /^([+-])(\d{2})(\d{2})$/.exec(stdout.trim())
      if (exitCode === 0 && match) {
        const minutes = Number(match[2]) * 60 + Number(match[3])
        offsetMinutes = match[1] === '-' ? -minutes : minutes
      }
    } catch {
      // Keep the runtime's own offset
    }
    try {
      const stored = await $.store.get(CACHE_KEY)
      if (Array.isArray(stored)) {
        cachedLimits = stored as SessionRateLimit[]
      }
    } catch {
      // No cache yet
    }
    $.ui.invalidate('ui.render')

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

  // The desktop footer strip draws this site only from a tree of Text, in its own type
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const usage = await $.session.usage()
    const { context } = usage
    const rateLimits = usage.rateLimits.length > 0 ? usage.rateLimits : fresh(cachedLimits, Date.now())
    const parts: string[] = []

    if (context.percent !== undefined) {
      parts.push(`⛁ ${context.percent}%`)
    }

    const fiveHour = findLimit(rateLimits, 'five_hour')
    if (fiveHour) {
      let text = `5h: ${Math.round(fiveHour.percentUsed)}%`
      if (fiveHour.resetsAt) {
        text += ` ${timeOf(local(Date.parse(fiveHour.resetsAt)))}`
      }
      parts.push(text)
    }

    const weekly = findLimit(rateLimits, 'seven_day')
    if (weekly) {
      parts.push(`W: ${Math.round(weekly.percentUsed)}%`)
    }

    if (parts.length === 0) {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)
    const modes = e.props.modes.length > 0 ? ` & ${e.props.modes.join(' & ')}` : ''

    return Text({ children: [parts.join(' · ') + modes] })
  })
}
