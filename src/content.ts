import { MAX_CARDS, step } from './recency'
import type {
  AdvanceResult,
  Candidate,
  KeySignal,
  OpenResult,
  OverlayPayload,
  ToContent,
  ToOverlay,
  ToWorker,
} from './types'

/**
 * The top frame owns the overlay and the input. Child frames only relay keys.
 * Key events do not cross document boundaries, so without a relay we would miss
 * the Ctrl keyup whenever focus sits in an iframe on the page.
 *
 * The relay goes through extension messaging, not in-page postMessage. Page
 * scripts in that frame can both forge and observe postMessage, which would let
 * a hostile page switch tabs on its own and learn keystrokes typed inside a
 * cross-origin frame.
 */
const IS_TOP = window.top === window

/** Window that absorbs a double advance from the shortcut and our own keydown. */
const ADVANCE_COALESCE_MS = 80
/**
 * Some Chromium forks dispatch a registered shortcut to the page but never
 * call chrome.commands.onCommand. Give the native command a brief head start,
 * then ask the worker to open the overlay ourselves.
 */
const COMMAND_FALLBACK_DELAY_MS = 120
/** Safety net so a missed keyup cannot leave the overlay up forever. */
const SAFETY_TIMEOUT_MS = 10_000
/** Safety net so a child frame that missed the disarm signal does not linger. */
const DISARM_FALLBACK_MS = SAFETY_TIMEOUT_MS + 2_000
const SCROLL_IDLE_MS = 900
const CAPTURE_REQUEST_INTERVAL_MS = 5_000

const EXT_ORIGIN = new URL(chrome.runtime.getURL('/')).origin

/** The cycle key. Keep in sync with commands in the manifest. */
function isCycleKey(key: string): boolean {
  return key === 'a' || key === 'A'
}

/**
 * The key that closes the focused tab.
 *
 * On Windows and Linux, Ctrl+W is the reserved "close tab" shortcut: the browser
 * closes the current tab before the event ever reaches the page. On macOS that
 * is Cmd+W, leaving Ctrl+W free, so it works as intended there.
 */
function isCloseKey(key: string): boolean {
  return key === 'w' || key === 'W'
}

function serialize(kind: 'keydown' | 'keyup', event: KeyboardEvent): KeySignal {
  return { kind, key: event.key, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey }
}

/** Only keys that can possibly drive the overlay are worth handling. */
function isRelevant(event: KeyboardEvent): boolean {
  const key = event.key
  if (key === 'Control') return true
  if (key === 'Backspace' || key === 'Escape') return true
  if (isCloseKey(key)) return true
  return isCycleKey(key) && event.ctrlKey
}

function tell(message: ToWorker): void {
  try {
    void chrome.runtime.sendMessage(message).catch(() => {})
  } catch {
    // The extension was reloaded and this context is invalidated.
  }
}

async function ask<T>(message: ToWorker): Promise<T | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T | undefined
  } catch {
    return undefined
  }
}

// ==================================================================== child frame

function installRelay(): void {
  let armed = false
  let disarmTimer: number | undefined

  const onKey = (kind: 'keydown' | 'keyup') => (event: KeyboardEvent) => {
    if (armed && kind === 'keydown') {
      // Swallow everything while the overlay is up. Otherwise Backspace deletes
      // characters in a text field while also cycling backwards.
      event.preventDefault()
      event.stopPropagation()
    }

    // Before arm, the top frame still needs the opening shortcut's physical Ctrl
    // state. Otherwise a quick tap in a child frame can release Ctrl before arm
    // arrives, leaving the overlay open until its safety timeout commits.
    const openingSignal =
      event.key === 'Control' || (isCycleKey(event.key) && event.ctrlKey)
    if (!(armed ? isRelevant(event) : openingSignal)) return
    tell({ type: 'relay-key', signal: serialize(kind, event) })
  }

  window.addEventListener('keydown', onKey('keydown'), true)
  window.addEventListener('keyup', onKey('keyup'), true)

  chrome.runtime.onMessage.addListener((raw) => {
    const message = raw as ToContent
    if (message.type === 'arm') {
      armed = true
      window.clearTimeout(disarmTimer)
      disarmTimer = window.setTimeout(() => {
        armed = false
      }, DISARM_FALLBACK_MS)
    } else if (message.type === 'disarm') {
      armed = false
      window.clearTimeout(disarmTimer)
    }
    return false
  })
}

// ==================================================================== top frame

function installTopFrame(): void {
  const token = Math.random().toString(36).slice(2)

  let framePending: Promise<HTMLIFrameElement> | null = null

  let isOpen = false
  let ring: Candidate[] = []
  let focusIndex = 0
  /**
   * Whether a registered extension shortcut's keydown reaches the page is up to
   * the browser. Once we have seen one, drive the cycling ourselves and skip the
   * round trip through the service worker.
   */
  let localKeyCapable = false
  let lastAdvanceAt = 0
  let safetyTimer: number | undefined
  let lastCaptureRequestAt = 0
  let commandFallbackTimer: number | undefined

  /**
   * Record of keys that would otherwise be lost in the async gap before open
   * arrives.
   *
   * The service worker makes several storage reads and tab queries, so tapping
   * Ctrl+A and releasing quickly delivers the keyup before open. Doing nothing
   * would leave the overlay up until the 10 second safety net fires — and that
   * tap is the single most common operation.
   */
  let ctrlDownAt = 0
  let ctrlUpAt = 0
  let pressesWhileClosed = 0

  /**
   * Tab ids closed with W, excluded when asking for a replacement.
   *
   * tabs.onRemoved is async, so a tab closed a moment ago can still sit in the
   * service worker's stack and come back as the replacement.
   */
  const closedTabIds = new Set<number>()
  /**
   * Serializes replacement requests. Hammering W would fire the next request
   * before the previous response arrives, hand back the same tab twice and
   * duplicate a card.
   */
  let refills: Promise<unknown> = Promise.resolve()

  function ensureFrame(): Promise<HTMLIFrameElement> {
    if (framePending) return framePending
    framePending = new Promise((resolve) => {
      const el = document.createElement('iframe')
      el.setAttribute('aria-hidden', 'true')
      el.setAttribute('tabindex', '-1')
      // Nailed down with !important so page CSS cannot squash it.
      el.setAttribute(
        'style',
        [
          'position: fixed !important',
          'inset: 0 !important',
          'width: 100% !important',
          'height: 100% !important',
          'margin: 0 !important',
          'padding: 0 !important',
          'border: 0 !important',
          'background: transparent !important',
          'background-color: transparent !important',
          // Per css-color-adjust, if the used color scheme of the iframe element
          // and that of the embedded document's root element disagree, the
          // canvas is painted opaque and hides the page behind it.
          //
          // What gets compared is the iframe element, not the page, so pin both
          // sides to the same single scheme together with overlay.css and
          // overlay.html. "only" keeps the browser's forced dark mode from
          // moving it. !important so page rules for iframes cannot win.
          'color-scheme: only dark !important',
          'z-index: 2147483647 !important',
          'pointer-events: none !important',
          'display: none !important',
          'opacity: 1 !important',
          'visibility: visible !important',
          'transform: none !important',
          'filter: none !important',
          'clip-path: none !important',
        ].join('; '),
      )
      el.addEventListener(
        'load',
        () => {
          // The token is not in the URL: the src attribute is readable from the
          // page, so it would be no secret. The page can post messages into this
          // iframe but cannot read the ones we post to it.
          el.contentWindow?.postMessage({ type: 'init', token } satisfies ToOverlay, EXT_ORIGIN)
          resolve(el)
        },
        { once: true },
      )
      el.src = chrome.runtime.getURL('overlay.html')
      document.documentElement.appendChild(el)
    })
    return framePending
  }

  function toOverlay(message: OverlayPayload): void {
    void ensureFrame().then((el) => {
      el.contentWindow?.postMessage({ ...message, token } as ToOverlay, EXT_ORIGIN)
    })
  }

  function setVisible(visible: boolean): void {
    void ensureFrame().then((el) => {
      el.style.setProperty('display', visible ? 'block' : 'none', 'important')
    })
  }

  function openOverlay(candidates: Candidate[], index: number): boolean {
    window.clearTimeout(commandFallbackTimer)
    commandFallbackTimer = undefined
    // With focus in the address bar no key event reaches us at all, so the
    // overlay would be unusable. Let the service worker handle it.
    if (!document.hasFocus()) return false
    if (candidates.length < 2) return false

    // A z-index cannot beat the Fullscreen API top layer. Better to fall back to
    // an instant toggle than to cycle and commit over invisible cards.
    if (document.fullscreenElement) return false

    // Ctrl was already released during the gap, so there is no point showing
    // anything now. Fall back to an instant toggle — this is the path that makes
    // a single Ctrl+A tap jump to the previous tab.
    if (ctrlDownAt > 0 && ctrlUpAt > ctrlDownAt) {
      pressesWhileClosed = 0
      return false
    }

    ring = candidates
    closedTabIds.clear()
    // Honour any extra cycle keys pressed during the gap.
    focusIndex = step(candidates.length, 0, pressesWhileClosed > 0 ? pressesWhileClosed : index)
    pressesWhileClosed = 0
    isOpen = true
    // Keeps the first keydown and the service worker's advance from stacking up.
    lastAdvanceAt = Date.now()

    toOverlay({ type: 'render', candidates, focusIndex })
    setVisible(true)

    window.clearTimeout(safetyTimer)
    safetyTimer = window.setTimeout(commit, SAFETY_TIMEOUT_MS)
    return true
  }

  function scheduleCommandFallback(): void {
    if (commandFallbackTimer !== undefined || isOpen) return
    commandFallbackTimer = window.setTimeout(() => {
      commandFallbackTimer = undefined
      if (!isOpen) tell({ type: 'open-overlay' })
    }, COMMAND_FALLBACK_DELAY_MS)
  }

  function advance(delta: number): void {
    if (!isOpen) return
    const now = Date.now()
    if (now - lastAdvanceAt < ADVANCE_COALESCE_MS) return
    lastAdvanceAt = now

    focusIndex = step(ring.length, focusIndex, delta)
    toOverlay({ type: 'focus', focusIndex })
  }

  function teardown(): void {
    isOpen = false
    window.clearTimeout(safetyTimer)
    // Hiding the iframe alone leaves the panel inside still holding the previous
    // cards, which then flash for one frame on the next open. Hide the panel too.
    toOverlay({ type: 'hide' })
    setVisible(false)
  }

  function commit(): void {
    if (!isOpen) return
    const target = ring[focusIndex]
    teardown()
    if (focusIndex === 0 || !target) {
      tell({ type: 'cancel' })
    } else {
      tell({ type: 'commit', tabId: target.tabId })
    }
  }

  function cancel(): void {
    if (!isOpen) return
    teardown()
    tell({ type: 'cancel' })
  }

  /** Closes the focused card's tab and keeps the overlay up. */
  function closeFocused(): void {
    if (!isOpen) return
    const target = ring[focusIndex]
    if (!target) return

    closedTabIds.add(target.tabId)

    // Closing the current tab takes this page with it. Just clean up and bail.
    if (focusIndex === 0) {
      teardown()
      tell({ type: 'cancel' })
      tell({ type: 'close-tab', tabId: target.tabId })
      return
    }

    tell({ type: 'close-tab', tabId: target.tabId })
    const removedIndex = focusIndex
    ring = ring.filter((_, index) => index !== removedIndex)

    // Nothing left to switch to.
    if (ring.length < 2) {
      teardown()
      tell({ type: 'cancel' })
      return
    }

    // The next candidate moves up into the same slot. Only closing the last card
    // walks focus back by one.
    if (focusIndex >= ring.length) focusIndex = ring.length - 1
    // Sending render would rebuild every card and re-decode the thumbnails,
    // which flickers. Remove just the closed one.
    toOverlay({ type: 'remove', index: removedIndex, focusIndex })

    refill()
  }

  /** Moves the next not-yet-shown tab up into the freed slot. */
  function refill(): void {
    refills = refills
      .then(async () => {
        if (!isOpen || ring.length >= MAX_CARDS) return

        const exclude = [...ring.map((c) => c.tabId), ...closedTabIds]
        const candidate = await ask<Candidate | null>({ type: 'need-candidate', exclude })

        // Closed / already filled / out of candidates while we were waiting.
        if (!candidate || !isOpen || ring.length >= MAX_CARDS) return
        if (ring.some((c) => c.tabId === candidate.tabId)) return

        ring = [...ring, candidate]
        toOverlay({ type: 'append', candidate, focusIndex })
      })
      // A single rejection would stall every later refill, so swallow it.
      .catch(() => {})
  }

  function handleSignal(signal: KeySignal): void {
    // Track the physical Ctrl state even while closed: it tells us whether the
    // key was already released by the time open arrived.
    if (signal.key === 'Control') {
      if (signal.kind === 'keydown') {
        ctrlDownAt = Date.now()
        if (!isOpen) pressesWhileClosed = 0
      } else {
        ctrlUpAt = Date.now()
      }
    }

    if (!isOpen) {
      if (signal.kind === 'keydown' && signal.ctrlKey && isCycleKey(signal.key)) {
        localKeyCapable = true
        pressesWhileClosed += 1
        // Ctrl+Shift+A is intentionally only a backwards-cycle key after the
        // overlay is open; it has no matching extension command to start one.
        if (!signal.shiftKey) scheduleCommandFallback()
      }
      return
    }

    if (signal.kind === 'keyup') {
      if (signal.key === 'Control') commit()
      return
    }

    if (signal.ctrlKey && isCycleKey(signal.key)) {
      localKeyCapable = true
      advance(signal.shiftKey ? -1 : 1)
      return
    }
    if (isCloseKey(signal.key)) {
      closeFocused()
      return
    }
    if (signal.key === 'Backspace') {
      advance(-1)
      return
    }
    if (signal.key === 'Escape') {
      cancel()
    }
  }

  function onNativeKey(kind: 'keydown' | 'keyup') {
    return (event: KeyboardEvent) => {
      if (isOpen && kind === 'keydown') {
        // Swallow everything while the overlay is up: a Backspace reaching a
        // text field would delete characters.
        event.preventDefault()
        event.stopPropagation()
      }
      if (!isRelevant(event)) return
      handleSignal(serialize(kind, event))
    }
  }

  window.addEventListener('keydown', onNativeKey('keydown'), true)
  window.addEventListener('keyup', onNativeKey('keyup'), true)

  window.addEventListener('blur', () => {
    // Moved to another app or the address bar. The keyup will never arrive.
    if (isOpen) commit()
  })

  chrome.runtime.onMessage.addListener((raw, _sender, reply) => {
    const message = raw as ToContent
    switch (message.type) {
      case 'open':
        reply({ handled: openOverlay(message.candidates, message.focusIndex) } satisfies OpenResult)
        break
      case 'advance':
        // If we can pick up the key ourselves, skip this to avoid the round trip
        // delay. Always report whether we are open though: leaving the service
        // worker's state out of sync makes this tab unresponsive from then on.
        if (!localKeyCapable) advance(message.delta)
        reply({ open: isOpen } satisfies AdvanceResult)
        break
      case 'key':
        handleSignal(message.signal)
        break
      case 'arm':
      case 'disarm':
        // The top frame keeps its own state, so ignore these.
        break
    }
    return false
  })

  // Report og:image as a stand-in preview. Content scripts run in background
  // tabs too, so even a tab that was never shown gets a picture on its card.
  reportPoster()

  window.addEventListener(
    'scroll',
    debounce(() => {
      const now = Date.now()
      if (now - lastCaptureRequestAt < CAPTURE_REQUEST_INTERVAL_MS) return
      lastCaptureRequestAt = now
      tell({ type: 'idle-capture' })
    }, SCROLL_IDLE_MS),
    { passive: true },
  )
}

function reportPoster(): void {
  const selectors = [
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[property="twitter:image"]',
    'meta[name="twitter:image"]',
  ]
  for (const selector of selectors) {
    const content = document.querySelector<HTMLMetaElement>(selector)?.content?.trim()
    if (!content) continue
    try {
      const url = new URL(content, location.href).href
      if (/^https?:\/\//i.test(url)) tell({ type: 'poster', url })
    } catch {
      // Drop values that cannot be resolved against the page URL.
    }
    return
  }
}

function debounce(fn: () => void, waitMs: number): () => void {
  let timer: number | undefined
  return () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(fn, waitMs)
  }
}

if (IS_TOP) {
  installTopFrame()
} else {
  installRelay()
}
