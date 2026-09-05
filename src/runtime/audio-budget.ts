import { checkBudget, RUNTIME_LIMITS } from "./resource-budget"

// Use native streaming media, never Web Audio's whole-file PCM decode/cache.
export async function prepareRuntimeAudio(audio: HTMLAudioElement, url: string, signal: AbortSignal) {
  signal.throwIfAborted()
  let abort = () => {}
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      audio.onloadedmetadata = () => resolve()
      audio.onerror = () => reject(new Error("Invalid or unsupported runtime audio"))
      audio.preload = "metadata"
      audio.src = url
    })
    signal.throwIfAborted()
    checkBudget(Math.ceil(audio.duration * 1000), RUNTIME_LIMITS.audioDurationMs, "audio_duration_ms")
  } finally {
    signal.removeEventListener("abort", abort)
    audio.onloadedmetadata = audio.onerror = null
  }
}

export function playRuntimeAudio(audios: Map<string, HTMLAudioElement>, url: string, volume: number) {
  const audio = audios.get(url)
  if (!audio) return false // Unknown/external sounds cannot bypass the budget.
  if ([...audios.values()].filter(item => !item.paused && !item.ended).length >= RUNTIME_LIMITS.audioVoices) return false
  // ponytail: one voice per clip; add a bounded voice pool only if overlapping same-clip playback is required.
  audio.currentTime = 0
  audio.volume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1))
  void audio.play().catch(() => {}) // Browser autoplay policy is not a render failure.
  return true
}
