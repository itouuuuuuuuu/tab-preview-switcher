import type { Candidate, ToOverlay } from '../types'

/**
 * Rendering only. Key input is never handled here; the content script owns it.
 *
 * The parent is a page on an arbitrary origin, so event.origin cannot verify
 * anything. We adopt the token from the first init message and accept nothing
 * else afterwards. The token is not in the iframe URL because the src attribute
 * is readable from the page; it arrives by postMessage, and the page cannot read
 * messages posted into this iframe.
 */
let token: string | null = null

/** How long a card takes to collapse before leaving the DOM. Keep in sync with overlay.css. */
const LEAVE_MS = 140

function must(id: string): HTMLElement {
  const node = document.getElementById(id)
  if (!node) throw new Error(`overlay: #${id} not found`)
  return node
}

const panel = must('panel')
const row = must('row')

let cards: HTMLElement[] = []
let settleRenderFrame: number | undefined

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return
  const data = event.data as ToOverlay | undefined
  if (!data || typeof data !== 'object' || typeof data.token !== 'string') return

  if (data.type === 'init') {
    // Only the very first one counts.
    if (token === null) token = data.token
    return
  }
  if (token === null || data.token !== token) return

  if (data.type === 'hide') {
    // Cards are kept: decoded images stay warm and the next render replaces them
    // anyway. Nothing paints while the panel is hidden.
    panel.classList.remove('is-visible')
  } else if (data.type === 'render') {
    render(data.candidates, data.focusIndex)
  } else if (data.type === 'focus') {
    setFocus(data.focusIndex)
  } else if (data.type === 'remove') {
    removeCard(data.index, data.focusIndex)
  } else if (data.type === 'append') {
    appendCard(data.candidate, data.focusIndex)
  }
})

function render(candidates: Candidate[], focusIndex: number): void {
  // A newly loaded iframe can paint between DOM insertion and the focused class
  // taking effect. In that case the focus transition plays as an unintended
  // entrance animation. Keep motion disabled until this render has settled;
  // later focus changes still transition normally.
  panel.classList.add('is-rendering')
  if (settleRenderFrame !== undefined) window.cancelAnimationFrame(settleRenderFrame)
  cards = candidates.map((candidate) => buildCard(candidate))
  row.replaceChildren(...cards)
  setFocus(focusIndex)
  panel.classList.add('is-visible')
  settleRenderFrame = window.requestAnimationFrame(() => {
    panel.classList.remove('is-rendering')
    settleRenderFrame = undefined
  })
}

function setFocus(focusIndex: number): void {
  cards.forEach((card, index) => card.classList.toggle('is-focused', index === focusIndex))
}

/** Collapses the card before removing it. The rest are left alone, so no image is re-decoded. */
function removeCard(index: number, focusIndex: number): void {
  const leaving = cards[index]
  if (!leaving) return

  // Dropped from the array immediately, so later indices refer to the closed-up list.
  cards = cards.filter((_, i) => i !== index)
  leaving.classList.remove('is-focused')
  leaving.classList.add('is-leaving')
  window.setTimeout(() => leaving.remove(), LEAVE_MS)

  setFocus(focusIndex)
}

/** Appends the card that fills the freed slot, expanding it from a collapsed state. */
function appendCard(candidate: Candidate, focusIndex: number): void {
  const card = buildCard(candidate)
  card.classList.add('is-collapsed')
  row.append(card)
  cards = [...cards, card]

  // Without forcing a layout first, removing the class would not run a transition.
  void card.offsetWidth
  card.classList.remove('is-collapsed')

  setFocus(focusIndex)
}

function buildCard(candidate: Candidate): HTMLElement {
  const card = el('div', 'card')
  card.append(el('div', 'glow'))

  const body = el('div', 'body')
  body.append(buildPreview(candidate), buildLabel(candidate))
  card.append(body)
  return card
}

/** Real screenshot, then og:image, then a favicon card. */
function buildPreview(candidate: Candidate): HTMLElement {
  const src = candidate.thumbDataUrl ?? candidate.posterUrl
  if (!src) return buildPlaceholder(candidate)

  const img = document.createElement('img')
  img.className = 'thumb'
  img.alt = ''
  img.setAttribute('decoding', 'sync')
  img.addEventListener(
    'error',
    () => {
      // A remote og:image can fail to load.
      img.replaceWith(buildPlaceholder(candidate))
    },
    { once: true },
  )
  img.src = src
  return img
}

function buildPlaceholder(candidate: Candidate): HTMLElement {
  const box = el('div', 'placeholder')

  if (candidate.favIconUrl) {
    const icon = document.createElement('img')
    icon.className = 'placeholder-icon'
    icon.alt = ''
    icon.addEventListener('error', () => icon.replaceWith(initialBadge(candidate, 'placeholder-initial')), {
      once: true,
    })
    icon.src = candidate.favIconUrl
    box.append(icon)
  } else {
    box.append(initialBadge(candidate, 'placeholder-initial'))
  }

  if (candidate.host) box.append(el('div', 'placeholder-host', candidate.host))
  return box
}

function buildLabel(candidate: Candidate): HTMLElement {
  const label = el('div', 'label')

  if (candidate.favIconUrl) {
    const icon = document.createElement('img')
    icon.className = 'favicon'
    icon.alt = ''
    icon.addEventListener('error', () => icon.replaceWith(initialBadge(candidate, 'favicon-fallback')), {
      once: true,
    })
    icon.src = candidate.favIconUrl
    label.append(icon)
  } else {
    label.append(initialBadge(candidate, 'favicon-fallback'))
  }

  const title = el('div', 'title', candidate.title)
  title.title = candidate.title
  label.append(title)
  return label
}

function initialBadge(candidate: Candidate, className: string): HTMLElement {
  const source = candidate.host || candidate.title
  return el('div', className, source.slice(0, 1))
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
