import type { Register, SessionRateLimit } from 'claude-code'

// Minutes east of UTC, read from the host once (the module may run in UTC)
let offsetMinutes = -new Date().getTimezoneOffset()

const pad = (n: number) => String(n).padStart(2, '0')

// Shift a timestamp into local wall-clock time, read back with the UTC getters
const local = (ms: number) => new Date(ms + offsetMinutes * 60_000)

const timeOf = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`

const findLimit = (limits: SessionRateLimit[], kind: string) =>
  limits.find(limit => limit.kind === kind)

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
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('session.measure', ($, e, next) => {
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // The desktop footer strip draws this site only from a tree of Text, in its own type
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { context, rateLimits } = await $.session.usage()
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
