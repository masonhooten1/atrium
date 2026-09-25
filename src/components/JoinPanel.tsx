'use client'

import { useEffect, useState } from 'react'
import { AVATAR_COLORS, HAT_IDS, type AvatarProfile, type HatId } from '@/lib/avatar-presets'

// Step one of onboarding: the identity picker. It gets a named, styled
// avatar onto the street; the guided walk (WorldCanvas + lib/onboarding)
// then teaches movement on the way to the hall.
export default function JoinPanel({ onJoin }: { onJoin: (p: AvatarProfile) => void }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(AVATAR_COLORS[3])
  const [hat, setHat] = useState<HatId>('cap')

  // Random default name after mount — avoids an SSR hydration mismatch.
  useEffect(() => {
    setName(`Visitor-${Math.floor(1000 + Math.random() * 9000)}`)
  }, [])

  return (
    <div
      data-testid="join-panel"
      className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm"
    >
      <form
        className="w-80 rounded-2xl border border-white/10 bg-slate-900/95 p-6 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault()
          onJoin({ name: name.trim() || 'Visitor', color, hat })
        }}
      >
        <h2 className="text-lg font-semibold">Step into Atrium</h2>
        <p className="mt-1 text-sm text-slate-400">Pick a look — the street knows you by it.</p>

        <label className="mt-4 block text-xs font-medium text-slate-300" htmlFor="name">
          Name
        </label>
        <input
          id="name"
          data-testid="name-input"
          className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm"
          value={name}
          maxLength={24}
          placeholder="Your name"
          onChange={(e) => setName(e.target.value)}
        />

        <span className="mt-4 block text-xs font-medium text-slate-300">Color</span>
        <div className="mt-2 flex gap-2">
          {AVATAR_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              aria-label={`color ${c}`}
              data-testid={`color-${i}`}
              onClick={() => setColor(c)}
              className={`h-7 w-7 rounded-full border-2 transition ${color === c ? 'border-white' : 'border-transparent'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>

        <span className="mt-4 block text-xs font-medium text-slate-300">Hat</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {HAT_IDS.map((h) => (
            <button
              key={h}
              type="button"
              data-testid={`hat-${h}`}
              onClick={() => setHat(h)}
              className={`rounded-lg border px-2.5 py-1 text-xs capitalize transition ${
                hat === h ? 'border-white bg-white/10 text-white' : 'border-white/10 text-slate-300'
              }`}
            >
              {h}
            </button>
          ))}
        </div>

        <button
          type="submit"
          data-testid="enter"
          className="mt-6 w-full rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400"
        >
          Enter the street
        </button>
      </form>
    </div>
  )
}
