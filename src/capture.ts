import { putThumb } from './store'

/**
 * captureVisibleTab can only shoot the active tab and is limited to two calls
 * per second. When the limit bites we do not retry; the cached image stays.
 */
const MIN_INTERVAL_MS = 700
const TARGET_WIDTH = 420
const JPEG_QUALITY = 0.6

let lastCaptureAt = 0

/**
 * Confirms tabId is still the visible one, then captures, shrinks and stores it.
 * Failures are swallowed.
 *
 * captureVisibleTab takes no tabId — it shoots whatever is on screen right now.
 * If the tab changed during a delayed call, we would store another tab's screen
 * under this tabId.
 */
export async function captureVisible(windowId: number, tabId: number): Promise<void> {
  if (Date.now() - lastCaptureAt < MIN_INTERVAL_MS) return

  try {
    const [active] = await chrome.tabs.query({ active: true, windowId })
    if (active?.id !== tabId) return

    // Recorded after the check so a bail-out does not burn the rate limit.
    lastCaptureAt = Date.now()
    const raw = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 })
    if (!raw) return
    await putThumb(tabId, await shrink(raw))
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
