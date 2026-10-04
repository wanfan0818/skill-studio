/**
 * While Skill Studio itself is writing into skill directories, the file
 * watcher must not treat those events as external changes.
 */
let applying = 0
let releaseTimer: ReturnType<typeof setTimeout> | null = null

export function isApplying(): boolean {
  return applying > 0 || releaseTimer !== null
}

/** Run `fn` with the watcher muted; stays muted 1.5s after so late FS events drain. */
export async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  applying++
  if (releaseTimer) {
    clearTimeout(releaseTimer)
    releaseTimer = null
  }
  try {
    return await fn()
  } finally {
    applying--
    if (applying === 0) {
      releaseTimer = setTimeout(() => {
        releaseTimer = null
      }, 1500)
      releaseTimer.unref?.()
    }
  }
}
