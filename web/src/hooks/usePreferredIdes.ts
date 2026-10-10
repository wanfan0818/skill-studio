import { useEffect, useState } from 'react'

/** Fired after the preferred-IDE list changes so every picker refreshes. */
export const PREFERRED_IDES_CHANGED = 'skill-studio:preferred-ides-changed'

/**
 * The IDEs the user actually uses (server-resolved). Pickers show only these;
 * `null` while loading — callers should then fall back to showing nothing extra.
 */
export function usePreferredIdes(): string[] | null {
  const [ides, setIdes] = useState<string[] | null>(null)
  useEffect(() => {
    const load = () =>
      fetch('/api/settings')
        .then((r) => r.json())
        .then((d) => d.ok && setIdes(d.settings.preferredIdes ?? []))
        .catch(() => {})
    load()
    window.addEventListener(PREFERRED_IDES_CHANGED, load)
    return () => window.removeEventListener(PREFERRED_IDES_CHANGED, load)
  }, [])
  return ides
}
