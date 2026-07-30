/** One card's worth of data in the overlay. */
export interface Candidate {
  tabId: number
  title: string
  /** Host shown on the card. Empty for things like about:blank. */
  host: string
  favIconUrl?: string
  /** Captured screenshot as a data URL. */
  thumbDataUrl?: string
  /** Stand-in preview such as og:image, as a remote URL. */
  posterUrl?: string
}

/** Minimal shape of a key event, serialized so child frames can relay it. */
export interface KeySignal {
  kind: 'keydown' | 'keyup'
  key: string
  ctrlKey: boolean
  shiftKey: boolean
}

/** Service worker to content script. */
export type ToContent =
  | { type: 'open'; candidates: Candidate[]; focusIndex: number }
  | { type: 'advance'; delta: number }
  | { type: 'key'; signal: KeySignal }
  /** Enables or disables key watching in child frames. Sent to every frame. */
  | { type: 'arm' }
  | { type: 'disarm' }

/** Content script to service worker. */
export type ToWorker =
  /**
   * Fallback for Chromium forks that deliver an extension shortcut to the page
   * but do not fire chrome.commands.onCommand (notably some Arc versions).
   */
  | { type: 'open-overlay' }
  | { type: 'commit'; tabId: number }
  | { type: 'cancel' }
  | { type: 'close-tab'; tabId: number }
  /**
   * A card slot opened up, so hand over the next tab that is not shown yet.
   * exclude must list every shown tab id plus the ones just closed, because
   * tabs.onRemoved is async and a tab closed a moment ago can still be in the
   * stack.
   */
  | { type: 'need-candidate'; exclude: number[] }
  | { type: 'poster'; url: string }
  | { type: 'idle-capture' }
  /**
   * Forwards a key picked up in a child frame to the top frame. In-page
   * postMessage is not used: page scripts can both forge and observe it.
   */
  | { type: 'relay-key'; signal: KeySignal }

/** Payload from the content script to the overlay iframe. */
export type OverlayPayload =
  /** Carries the token in the very first message. Never in the iframe URL. */
  | { type: 'init' }
  /**
   * Hides the panel. Sent on close.
   *
   * The iframe is reused per page, so without this the panel keeps the previous
   * cards and they flash for one frame on the next open.
   */
  | { type: 'hide' }
  | { type: 'render'; candidates: Candidate[]; focusIndex: number }
  | { type: 'focus'; focusIndex: number }
  /**
   * Removes a single card. Re-sending render would rebuild every card, re-decode
   * the thumbnails and replay the panel fade-in, so closing always uses this.
   */
  | { type: 'remove'; index: number; focusIndex: number }
  /** Appends a card to fill the freed slot. */
  | { type: 'append'; candidate: Candidate; focusIndex: number }

/** The page's origin cannot be verified, so every message carries a token. */
export type ToOverlay = OverlayPayload & { token: string }

/** Result of an open request. false makes the service worker toggle instantly. */
export interface OpenResult {
  handled: boolean
}

/** Result of an advance request. open: false means the two states disagree. */
export interface AdvanceResult {
  open: boolean
}
