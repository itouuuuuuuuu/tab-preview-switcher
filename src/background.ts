import { captureVisible } from './capture'
import { buildRing, candidatesNotIn, drop, seedFromTabStrip, touch } from './recency'
import * as store from './store'
import type { AdvanceResult, Candidate, OpenResult, ToContent, ToWorker } from './types'

/** Right after activation the tab has not finished painting, so wait a moment. */
const ACTIVATION_CAPTURE_DELAY_MS = 350
const LOAD_CAPTURE_DELAY_MS = 250

const BLOCKED_SCHEME =
  /^(chrome|brave|edge|opera|vivaldi|about|devtools|chrome-extension|moz-extension|view-source|data|blob|filesystem|file|ftp):/i
const BLOCKED_URL = [
  /^https:\/\/chromewebstore\.google\.com\//i,
  /^https:\/\/chrome\.google\.com\/webstore\//i,
]

/**
 * Serializes every read-modify-write of the recency stack.
 *
 * Storage reads and writes are separate async calls, so opening several
 * background tabs in quick succession makes multiple bump() calls read the same
 * stack and clobber each other's writes. That breaks the whole point of this
 * extension — a tab opened in the background being the first candidate — so all
 * updates must go through here.
 */
let mutations: Promise<unknown> = Promise.resolve()
let overlayActions: Promise<unknown> = Promise.resolve()

/**
 * A content-script fallback may open the overlay just before a delayed native
 * command arrives. Do not treat that one physical shortcut as a second cycle.
 */
let lastFallbackOpenAt = 0
const FALLBACK_COMMAND_DEDUP_MS = 250

function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = mutations.then(task, task)
  mutations = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Prevents native commands and the delayed Arc fallback from opening twice. */
function exclusiveOverlay<T>(task: () => Promise<T>): Promise<T> {
  const run = overlayActions.then(task, task)
  overlayActions = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ---------------------------------------------------------------- recency

function bump(tabId: number, windowId: number): Promise<void> {
  return exclusive(async () => {
    const stack = await store.getStack(windowId)
    await store.setStack(windowId, touch(stack, tabId))
  })
}

function forget(tabId: number, windowId: number): Promise<void> {
  return exclusive(async () => {
    const stack = await store.getStack(windowId)
    await store.setStack(windowId, drop(stack, tabId))
  })
}

/**
 * Reconciles the stored stack against the tabs that actually exist and returns
 * every tabId in recency order.
 *
 * Tabs missing from the stack (open since before install and never activated)
 * are appended. Tabs that were closed while an onRemoved event was missed are
 * dropped.
 */
function orderedTabs(windowId: number): Promise<number[]> {
  return exclusive(async () => {
    const stored = await store.getStack(windowId)
    const tabs = await chrome.tabs.query({ windowId })

    const alive = tabs.map((t) => t.id).filter((id): id is number => typeof id === 'number')
    const aliveSet = new Set(alive)
    const kept = stored.filter((id) => aliveSet.has(id))
    const keptSet = new Set(kept)
    const merged = [...kept, ...alive.filter((id) => !keptSet.has(id))]

    await store.setStack(windowId, merged)
    return merged
  })
}

async function ringFor(windowId: number, activeTabId: number): Promise<number[]> {
  return buildRing(await orderedTabs(windowId), activeTabId)
}

/**
 * The next not-yet-shown tab, used to fill the slot freed by W.
 *
 * Do not give up after the first one. The tab can be closed between listing it
 * and calling tabs.get, which would leave the slot empty even though other
 * candidates remain.
 */
async function pickReplacement(windowId: number, exclude: number[]): Promise<Candidate | null> {
  for (const tabId of candidatesNotIn(await orderedTabs(windowId), exclude)) {
    const candidate = await toCandidate(tabId, { windowId })
    if (candidate) return candidate
  }
  return null
}

// ---------------------------------------------------------------- candidates

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * The second parameter is an object so that passing this function directly —
 * `ids.map(toCandidate)` — is a type error. map hands the array index to the
 * second parameter, so a bare `windowId: number` would silently receive the
 * index, reject every candidate and leave the overlay empty. That regression
 * actually shipped once.
 */
async function toCandidate(
  tabId: number,
  expect: { windowId: number },
): Promise<Candidate | undefined> {
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return undefined
  }
  // tabs.get still succeeds for a tab moved to another window between listing
  // and here, which would smuggle in a card that violates "current window only"
  if (tab.windowId !== expect.windowId) return undefined

  const [thumbDataUrl, posterUrl] = await Promise.all([
    store.getThumb(tabId),
    store.getPoster(tabId),
  ])
  const host = hostOf(tab.url)

  return {
    tabId,
    title: tab.title?.trim() || host || '(untitled)',
    host,
    favIconUrl: tab.favIconUrl,
    thumbDataUrl,
    posterUrl,
  }
}

// ---------------------------------------------------------------- messaging

/** Sends to the top frame only. */
async function post(tabId: number, message: ToContent): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 })
    return true
  } catch {
    return false
  }
}

/** Sends to every frame in the tab. */
async function postAll(tabId: number, message: ToContent): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message)
  } catch {
    // Simply no frame around to receive it.
  }
}

async function requestOpen(
  tabId: number,
  candidates: Candidate[],
): Promise<OpenResult | undefined> {
  const message: ToContent = { type: 'open', candidates, focusIndex: 1 }
  try {
    return (await chrome.tabs.sendMessage(tabId, message, { frameId: 0 })) as
      | OpenResult
      | undefined
  } catch {
    // The PDF viewer, or a page where the content script is not running yet.
    return undefined
  }
}

async function requestAdvance(tabId: number, delta: number): Promise<AdvanceResult | undefined> {
  const message: ToContent = { type: 'advance', delta }
  try {
    return (await chrome.tabs.sendMessage(tabId, message, { frameId: 0 })) as
      | AdvanceResult
      | undefined
  } catch {
    return undefined
  }
}

function isInjectable(url: string | undefined): boolean {
  if (!url) return false
  if (BLOCKED_SCHEME.test(url)) return false
  if (BLOCKED_URL.some((re) => re.test(url))) return false
  return /^https?:\/\//i.test(url)
}

// ---------------------------------------------------------------- commands

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'cycle-forward') return
  const commandAt = Date.now()
  void exclusiveOverlay(() => handleCommand(commandAt))
})

async function handleCommand(commandAt: number): Promise<void> {
  // Compare the event time, not the time this serialized action starts. A slow
  // fallback open can keep the matching native command queued for over 250ms.
  if (commandAt - lastFallbackOpenAt < FALLBACK_COMMAND_DEDUP_MS) return
  const overlay = await store.getOverlay()
  if (overlay) {
    const result = await requestAdvance(overlay.tabId, 1)
    // Delivery can succeed while the content script is actually closed, because
    // the page was rebuilt. Without checking the real state the shortcut stays
    // dead in this tab forever.
    if (result?.open) return
    await store.setOverlay(null)
    void postAll(overlay.tabId, { type: 'disarm' })
  }
  await openOverlay()
}

async function openOverlay(): Promise<void> {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const tabId = active?.id
  if (!active || tabId === undefined) return
  const windowId = active.windowId

  // Capture the current tab right before leaving it: the freshest shot we can
  // get. Do not make the overlay wait for it.
  void captureVisible(windowId, tabId)

  const ring = await ringFor(windowId, tabId)
  if (ring[1] === undefined) return // Nowhere to switch to.

  if (!isInjectable(active.url)) {
    await switchToFirstIn(ring, windowId)
    return
  }

  const candidates = (await Promise.all(ring.map((id) => toCandidate(id, { windowId })))).filter(
    (c): c is Candidate => c !== undefined,
  )
  // If the current tab moved to another window after listing, we would send the
  // old window's candidates to the moved tab and break the invariant that the
  // leading card is the current tab.
  if (candidates.length < 2 || candidates[0]?.tabId !== tabId) {
    await switchToFirstIn(ring, windowId)
    return
  }

  const result = await requestOpen(tabId, candidates)
  if (result?.handled) {
    await store.setOverlay({ tabId, windowId })
    void postAll(tabId, { type: 'arm' })
  } else {
    // No content script / the page has no keyboard focus / Ctrl was already
    // released / element fullscreen is active.
    await switchToFirstIn(ring, windowId)
  }
}

/**
 * Switches to the first tab that is still in this window, skipping the head of
 * the ring (the current tab).
 *
 * Never use a bare ring[1]. If that tab moved to another window between listing
 * and switching, we would jump to another window and violate "candidates come
 * from the current window only". Closed tabs are skipped the same way.
 */
async function switchToFirstIn(ring: readonly number[], windowId: number): Promise<void> {
  for (const tabId of ring.slice(1)) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.windowId !== windowId) continue
      await chrome.tabs.update(tabId, { active: true })
      return
    } catch {
      // Already closed. Try the next candidate.
    }
  }
}

async function switchTo(tabId: number, windowId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.windowId !== windowId) return
    await chrome.tabs.update(tabId, { active: true })
  } catch {
    // Already closed or moved while the overlay was open.
  }
}

async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId)
  } catch {
    // Already closed.
  }
}

async function closeOverlay(sourceTabId: number | undefined): Promise<void> {
  await store.setOverlay(null)
  if (sourceTabId !== undefined) void postAll(sourceTabId, { type: 'disarm' })
}

// ------------------------------------------------- messages from content script

chrome.runtime.onMessage.addListener((raw, sender, reply) => {
  const message = raw as ToWorker
  const tabId = sender.tab?.id

  switch (message.type) {
    case 'open-overlay':
      // In Chromium this is normally unnecessary because commands.onCommand
      // fires first. Arc can expose the key to the page without firing that
      // event, so use the page signal only while no overlay is already open.
      void exclusiveOverlay(async () => {
        if (await store.getOverlay()) return
        lastFallbackOpenAt = Date.now()
        await openOverlay()
      })
      return false

    case 'commit':
      void (async () => {
        const overlay = await store.getOverlay()
        const windowId =
          overlay && overlay.tabId === tabId ? overlay.windowId : sender.tab?.windowId
        await closeOverlay(tabId)
        if (windowId !== undefined) await switchTo(message.tabId, windowId)
      })()
      return false

    case 'cancel':
      void closeOverlay(tabId)
      return false

    case 'close-tab':
      void closeTab(message.tabId)
      return false

    case 'need-candidate': {
      const windowId = sender.tab?.windowId
      if (windowId === undefined) {
        reply(null)
        return false
      }
      // Returns true because a response follows; otherwise the content script
      // would wait forever.
      void pickReplacement(windowId, message.exclude).then(reply, () => reply(null))
      return true
    }

    case 'poster':
      if (tabId !== undefined && sender.frameId === 0) void store.putPoster(tabId, message.url)
      return false

    case 'idle-capture':
      if (tabId !== undefined && sender.tab?.active) {
        void captureVisible(sender.tab.windowId, tabId)
      }
      return false

    case 'relay-key':
      // Forward a key picked up in a child frame to the top frame.
      if (tabId !== undefined && sender.frameId !== 0) {
        void post(tabId, { type: 'key', signal: message.signal })
      }
      return false
  }
  return false
})

// ---------------------------------------------------------------- tab events

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void bump(tabId, windowId)
  setTimeout(() => void captureVisible(windowId, tabId), ACTIVATION_CAPTURE_DELAY_MS)
})

chrome.tabs.onCreated.addListener((tab) => {
  // The crux of making a background-opened tab the first candidate: onActivated
  // never fires for it.
  if (tab.id !== undefined) void bump(tab.id, tab.windowId)
})

chrome.tabs.onRemoved.addListener((tabId, info) => {
  void (async () => {
    await forget(tabId, info.windowId)
    await store.forgetTab(tabId)
    const overlay = await store.getOverlay()
    if (overlay?.tabId === tabId) await store.setOverlay(null)
  })()
})

chrome.tabs.onDetached.addListener((tabId, info) => {
  void forget(tabId, info.oldWindowId)
})

chrome.tabs.onAttached.addListener((tabId, info) => {
  void bump(tabId, info.newWindowId)
})

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'loading') {
    // A screenshot or poster belongs to the previous document. Keeping it would
    // label the new URL with imagery from an unrelated (and possibly sensitive)
    // page, especially when a background tab navigates and cannot be recaptured.
    void store.clearPreview(tabId)
    // Rebuilding the page wipes the content script's state, so drop ours too.
    void (async () => {
      const overlay = await store.getOverlay()
      if (overlay?.tabId === tabId) await store.setOverlay(null)
    })()
    return
  }
  if (change.status !== 'complete' || !tab.active) return
  setTimeout(() => void captureVisible(tab.windowId, tabId), LOAD_CAPTURE_DELAY_MS)
})

chrome.windows.onRemoved.addListener((windowId) => {
  void store.dropWindow(windowId)
})

// ---------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(() => void seedAll())
chrome.runtime.onStartup.addListener(() => void seedAll())

/**
 * There is no way to learn the real recency, so stand in tab strip order with
 * the active tab first. From then on onActivated and onCreated build the real
 * order.
 */
function seedAll(): Promise<void> {
  return exclusive(async () => {
    await store.setOverlay(null)
    const windows = await chrome.windows.getAll({ populate: true })
    for (const win of windows) {
      if (win.id === undefined || !win.tabs) continue
      await store.setStack(win.id, seedFromTabStrip(win.tabs))
    }
  })
}
