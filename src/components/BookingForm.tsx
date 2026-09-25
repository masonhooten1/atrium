'use client'

// Booking a boardroom slot from the street. The form posts to the API and
// reports the verdict verbatim: a 409 names the conflicting meeting, so the
// booker learns the room's future from the refusal itself.
import { useState } from 'react'

const DURATIONS = [
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 45, label: '45 min' },
  { minutes: 60, label: '1 h' },
  { minutes: 90, label: '1.5 h' },
]

interface ConflictInfo {
  title: string
  startsAt: number
  endsAt: number
}

const pad = (n: number): string => String(n).padStart(2, '0')

function nextHalfHour(now: number): number {
  const d = new Date(now)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + (30 - (d.getMinutes() % 30)))
  return d.getTime()
}

function toLocalInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function BookingForm({
  roomId,
  booker,
  onBooked,
}: {
  roomId: string
  booker: string
  onBooked?: (title: string, startsAt: number) => void
}) {
  const [title, setTitle] = useState('')
  const [startsAt, setStartsAt] = useState(() => toLocalInput(nextHalfHour(Date.now())))
  const [duration, setDuration] = useState(30)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const startMs = new Date(startsAt).getTime()
    if (!Number.isFinite(startMs) || title.trim().length === 0) {
      setError('A meeting needs a title and a start time.')
      return
    }
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomId,
          title: title.trim(),
          booker,
          startsAt: startMs,
          endsAt: startMs + duration * 60_000,
        }),
      })
      const data: { error?: string; conflict?: ConflictInfo | null } = await res.json().catch(() => ({}))
      if (res.status === 201) {
        setDone(`Booked · ${fmtTime(startMs)}–${fmtTime(startMs + duration * 60_000)}`)
        setTitle('')
        onBooked?.(title.trim(), startMs)
        return
      }
      if (res.status === 409) {
        const c = data?.conflict
        setError(
          c
            ? `"${c.title}" already holds the room ${fmtTime(c.startsAt)}–${fmtTime(c.endsAt)}.`
            : 'That time is already taken.',
        )
        return
      }
      if (res.status === 404) {
        setError('This room cannot be booked.')
        return
      }
      setError(data?.error === 'window' ? 'Pick a future start, and an end after it.' : 'Booking failed — try again.')
    } catch {
      setError('Booking failed — the street may be down.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      data-testid="booking-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className="rounded-xl border border-white/10 bg-slate-900/80 px-4 py-3 text-sm backdrop-blur"
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Book the boardroom</div>
      <input
        data-testid="booking-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Meeting title"
        maxLength={120}
        className="mt-2 w-full rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1.5 text-slate-100 placeholder:text-slate-500 focus:border-emerald-400/60 focus:outline-none"
      />
      <div className="mt-2 flex items-center gap-2">
        <input
          data-testid="booking-start"
          type="datetime-local"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1.5 text-xs text-slate-100 focus:border-emerald-400/60 focus:outline-none"
        />
        <select
          data-testid="booking-duration"
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
          className="rounded-lg border border-white/10 bg-slate-950/60 px-1.5 py-1.5 text-xs text-slate-100 focus:border-emerald-400/60 focus:outline-none"
        >
          {DURATIONS.map((d) => (
            <option key={d.minutes} value={d.minutes}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        data-testid="booking-submit"
        disabled={busy}
        className="mt-2 w-full rounded-lg bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
      >
        {busy ? 'Booking…' : 'Reserve'}
      </button>
      {error ? (
        <p data-testid="booking-error" className="mt-2 text-[11px] leading-snug text-rose-300">
          {error}
        </p>
      ) : null}
      {done ? (
        <p data-testid="booking-done" className="mt-2 text-[11px] leading-snug text-emerald-300">
          {done} — the door now shows it.
        </p>
      ) : null}
    </form>
  )
}
