import { getPreviewGeneration, putThumb } from './store'

/**
 * captureVisibleTab can only shoot the active tab and is limited to two calls
 * per second. When the limit bites we do not retry; the cached image stays.
 */
const MIN_INTERVAL_MS = 700
const TARGET_WIDTH = 420
const JPEG_QUALITY = 0.6

let lastCaptureAt = 0
let captures: Promise<unknown> = Promise.resolve()

/**
 * Confirms tabId is still the visible one, then captures, shrinks and stores it.
 * Failures are swallowed.
 *
 * captureVisibleTab takes no tabId — it shoots whatever is on screen right now.
 * If the tab changed during a delayed call, we would store another tab's screen
 * under this tabId.
 */
export function captureVisible(windowId: number, tabId: number): Promise<void> {
  const run = captures.then(
    () => captureVisibleNow(windowId, tabId),
    () => captureVisibleNow(windowId, tabId),
  )
  captures = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function captureVisibleNow(windowId: number, tabId: number): Promise<void> {
  if (Date.now() - lastCaptureAt < MIN_INTERVAL_MS) return

  try {
    const [active] = await chrome.tabs.query({ active: true, windowId })
    if (active?.id !== tabId) return
    const previewGeneration = getPreviewGeneration(tabId)

    // Recorded after the check so a bail-out does not burn the rate limit.
    lastCaptureAt = Date.now()
    const raw = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 })
    if (!raw) return

    // The tab can change after the pre-capture query while the browser processes
    // captureVisibleTab. Never associate that result with a tab that is no longer
    // visible.
    const [afterCapture] = await chrome.tabs.query({ active: true, windowId })
    if (afterCapture?.id !== tabId) return

    const thumbnail = await shrink(raw)
    const [beforeStore] = await chrome.tabs.query({ active: true, windowId })
    if (beforeStore?.id !== tabId) return
    if (getPreviewGeneration(tabId) !== previewGeneration) return
    await putThumb(tabId, thumbnail)
  } catch {
    // chrome://, the PDF viewer, exceeding the limit, a window that just closed.
  }
}

async function shrink(dataUrl: string): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
  try {
    const scale = Math.min(1, TARGET_WIDTH / bitmap.width)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.drawImage(bitmap, 0, 0, width, height)

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
    return `data:image/jpeg;base64,${toBase64(await blob.arrayBuffer())}`
  } finally {
    bitmap.close()
  }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunk = 8192
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
