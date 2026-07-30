/**
 * Thin wrapper over chrome.storage.session.
 *
 * Nothing is ever written to disk. A browser restart reassigns every tab id, so
 * persisting would not restore anything and would only leave JPEGs of browsed
 * pages behind. storage.session lives in the browser process, so it survives the
 * service worker being shut down.
 */

const KEY_MRU = (windowId: number) => `mru:${windowId}`
const KEY_THUMB = (tabId: number) => `thumb:${tabId}`
const KEY_POSTER = (tabId: number) => `poster:${tabId}`
const KEY_THUMB_ORDER = 'thumbOrder'
const KEY_OVERLAY = 'overlay'

/** How many tabs keep an image. At roughly 30KB each this leaves plenty of the session 10MB quota. */
const THUMB_LIMIT = 12

/**
 * Image cache updates contain read-modify-write sequences. Serialize them so
 * simultaneous captures, navigation cleanup and tab removal cannot lose the
 * thumbnail order or resurrect an image that was just cleared.
 */
let imageMutations: Promise<unknown> = Promise.resolve()
const previewGenerations = new Map<number, number>()

function mutateImages<T>(task: () => Promise<T>): Promise<T> {
  const run = imageMutations.then(task, task)
  imageMutations = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function readOne<T>(key: string): Promise<T | undefined> {
  const bag = await chrome.storage.session.get(key)
  return bag[key] as T | undefined
}

export async function getStack(windowId: number): Promise<number[]> {
  return (await readOne<number[]>(KEY_MRU(windowId))) ?? []
}

export async function setStack(windowId: number, stack: readonly number[]): Promise<void> {
  await chrome.storage.session.set({ [KEY_MRU(windowId)]: [...stack] })
}

export async function dropWindow(windowId: number): Promise<void> {
  await chrome.storage.session.remove(KEY_MRU(windowId))
}

export async function getThumb(tabId: number): Promise<string | undefined> {
  await imageMutations
  return readOne<string>(KEY_THUMB(tabId))
}

export function putThumb(tabId: number, dataUrl: string): Promise<void> {
  return mutateImages(async () => {
    const order = (await readOne<number[]>(KEY_THUMB_ORDER)) ?? []
    const next = [tabId, ...order.filter((id) => id !== tabId)]
    const evicted = next.splice(THUMB_LIMIT)

    await chrome.storage.session.set({ [KEY_THUMB(tabId)]: dataUrl, [KEY_THUMB_ORDER]: next })
    if (evicted.length > 0) {
      await chrome.storage.session.remove(evicted.map((id) => KEY_THUMB(id)))
    }
  })
}

export async function getPoster(tabId: number): Promise<string | undefined> {
  await imageMutations
  return readOne<string>(KEY_POSTER(tabId))
}

export function putPoster(tabId: number, url: string): Promise<void> {
  return mutateImages(async () => {
    await chrome.storage.session.set({ [KEY_POSTER(tabId)]: url })
  })
}

/** Changes synchronously when an in-flight capture for this tab becomes stale. */
export function getPreviewGeneration(tabId: number): number {
  return previewGenerations.get(tabId) ?? 0
}

/** Clears page-specific images while keeping the tab in the recency stack. */
export function clearPreview(tabId: number): Promise<void> {
  previewGenerations.set(tabId, getPreviewGeneration(tabId) + 1)
  return mutateImages(async () => {
    const order = (await readOne<number[]>(KEY_THUMB_ORDER)) ?? []
    await chrome.storage.session.set({ [KEY_THUMB_ORDER]: order.filter((id) => id !== tabId) })
    await chrome.storage.session.remove([KEY_THUMB(tabId), KEY_POSTER(tabId)])
  })
}

export function forgetTab(tabId: number): Promise<void> {
  return clearPreview(tabId)
}

/** The tab currently showing the overlay, kept so a service worker shutdown does not lose it. */
export interface OverlayState {
  tabId: number
  windowId: number
}

export async function getOverlay(): Promise<OverlayState | undefined> {
  return readOne<OverlayState>(KEY_OVERLAY)
}

export async function setOverlay(state: OverlayState | null): Promise<void> {
  if (state === null) {
    await chrome.storage.session.remove(KEY_OVERLAY)
  } else {
    await chrome.storage.session.set({ [KEY_OVERLAY]: state })
  }
}
