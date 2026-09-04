declare const Laya: any

export function disableRuntimeStorage() {
  // Laya's default PAL storage constructor reads window.localStorage during init.
  // Rendering needs no persistence; keep the real browser storage APIs inaccessible.
  Laya.PAL.register("storage", class {
    getItem() { return null }
    setItem() {}
    removeItem() {}
    clear() {}
    getCount() { return 0 }
  })
}

export function nextRuntimeFrame() {
  // Chromium pauses rAF in offscreen cross-origin frames. Commands must still finish;
  // capture uses drawToCanvas, not a promise that a hidden animation has settled.
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve() }, 50)
    const frame = requestAnimationFrame(() => { clearTimeout(timer); resolve() })
  })
}

export function flushRuntimeFrame() {
  // drawToCanvas alone can read stale/empty GPU buffers when the animation loop is paused.
  // Flush one native frame before taking the screenshot's observation/event watermark.
  const enabled = Laya.stage.renderingEnabled
  try {
    Laya.stage.renderingEnabled = true
    Laya.stage.render(performance.now())
  } finally { Laya.stage.renderingEnabled = enabled }
}
