# Tab Preview Switcher — Specification

A Chrome / Brave extension that switches tabs in most-recently-opened order while showing tab previews.

## 1. Browser constraints this design starts from

Every one of these is immovable.

- **`Ctrl+Tab` cannot be taken.** `chrome.commands` dropped Tab from its supported keys in Chrome 33, so it cannot even be bound. In a content script, `Ctrl+Tab` and `Ctrl+Shift+Tab` are reserved shortcuts: the key event is never dispatched to the renderer and `preventDefault()` is ignored. "Hold `Ctrl` and tap `Tab`" is therefore impossible to implement.
- **`chrome.tabs.captureVisibleTab()` can only shoot the active tab.** Background tabs cannot be captured, so a preview is always a snapshot from when that tab was last visible. Calls are limited to two per second.
- **Some pages cannot host a content script.** `chrome://*`, `brave://*`, the new tab page, the Chrome Web Store, extension pages, `view-source:`, the PDF viewer, `file://` (not by default). The overlay cannot be drawn at all in those tabs.
- **An MV3 service worker shuts down after roughly 30 seconds idle.** State kept only in service worker globals disappears.

## 2. Input

| Action | Behaviour |
| --- | --- |
| `Ctrl+A` (`MacCtrl+A` on macOS) | Opens the overlay with **candidate 1 focused** |
| `A` again while holding `Ctrl` | Cycles to the next candidate |
| `Backspace` | Cycles backwards |
| `Ctrl+Shift+A` | Cycles backwards (taken by Chrome's tab search on Windows / Linux) |
| `W` | **Closes the focused card's tab** (macOS only, see below) |
| `Esc` | Cancels: stays on the current tab and no longer commits when `Ctrl` is released |
| Release `Ctrl` | Commits to the focused card |
| Window blur / 10 seconds elapsed | Commits to the focused card (safety net for a missed keyup) |
| Any other key | Swallowed and ignored while the overlay is up |

`Ctrl+A` can be changed at `chrome://extensions/shortcuts` (`brave://extensions/shortcuts` in Brave).

### The price of choosing `Ctrl+A`

Registering an extension shortcut makes the browser consume the key, so it collides with select-all.

- **Little real harm on macOS.** Select-all is `Cmd+A`, which does not collide with `MacCtrl+A`; the only casualty is "move to start of line" (the emacs binding) in text fields.
- **Select-all breaks on Windows / Linux**, where `Ctrl+A` goes to the extension.

### Closing a tab (`W`)

Pressing `W` while the overlay is up closes the focused card's tab and keeps the overlay open.

- The next candidate moves up into the same slot. Only closing the last card walks focus back by one.
- **The freed slot is filled by the next not-yet-shown tab, bringing the count back to 5.** The display list is otherwise frozen when the overlay opens; a closed slot is the one exception. The overlay only holds five cards' worth of data, so it asks the service worker for the next tab excluding every shown tab id and the ones just closed.

  Five cards are not guaranteed. While the request is in flight there are four, and if no candidate is available it simply continues with four.
- **Do not give up on the first candidate.** The tab can be closed between listing it and calling `tabs.get`, which would leave the slot empty even though other candidates remain. Walk the whole recency-ordered list minus the exclusions. `tabs.get` also succeeds for a tab that moved to another window, so **always verify the returned tab's `windowId`**; otherwise a card sneaks in that violates "candidates come from the current window only".
- Replacement requests are **serialized**. Hammering `W` would fire the next request before the previous response arrives, hand back the same tab twice and duplicate a card.
- The exclusion list **must include the tab ids just closed**. `tabs.onRemoved` is async, so a tab closed a moment ago is still in the stack and comes back as the replacement.
- **Use the dedicated message that removes a single card.** Re-sending `render` rebuilds every card and re-decodes the thumbnails, which visibly flickers. The card being removed collapses its width over 140ms before leaving the DOM, and the rest are never touched. The card moving up expands over the same 140ms.
- The overlay closes once there is nothing left to switch to.
- Closing also works when focus is on the current tab (the leading card). The page hosting the overlay disappears in that case, so the state is cleaned up before the close request goes out.
- **Does not work on Windows / Linux.** `Ctrl+W` is the reserved "close tab" shortcut: **the browser closes the current tab** before the event reaches the page, leaving no room for the extension. On macOS that is `Cmd+W`, so `Ctrl+W` is free and this works as intended.

### What the first press means

A single `Ctrl+A` **toggles to the previous tab**. That matches the muscle memory of `Cmd+Tab` on macOS and `Alt+Tab` on Windows, and it is by far the most frequent operation.

The original requirement said "the current tab is focused first". That is interpreted as **a statement about card order** (the leading card is the current tab). Implemented literally as a focus position, a single press would do nothing and the most frequent operation would need two presses.

### The ring

Focus travels a circular list that includes the current tab.

```
current → cand 1 → cand 2 → cand 3 → cand 4 → current → …
```

`Backspace` from candidate 1 goes to the current tab, and again from there to candidate 4.

## 3. Switching order

One recency stack per window, independent of the others.

- **Both** `tabs.onActivated` and `tabs.onCreated` move that tab to the front of the stack.
- A tab opened in the background therefore becomes the first candidate without ever having been shown. Open three links in the background and **the last one opened** is the first candidate.
- `tabs.onRemoved` removes it from the stack. `onAttached` / `onDetached` move it between windows.
- Candidates come from the **current window only**. Tabs in other windows are never offered, because moving window focus on commit would lose the `Ctrl` keyup.
- When the stack has not been built yet (just installed, just restarted), tab strip order with the active tab first stands in.

The display list is the first five of `[current tab, ...stack without the current tab]`. It is **frozen the moment the overlay opens**; cards do not move as tabs come and go while it is up.

## 4. Preview images

A three-step fallback.

1. **A real screenshot.** Captured (a) on the current tab the moment the overlay opens (right before leaving it, so the freshest), (b) 350ms after a tab becomes active, (c) when a page finishes loading, (d) on a scroll-stopped notification from the content script. All debounced; when the two-per-second limit bites there is no retry and the cached image stays.

   `captureVisibleTab()` takes no tabId and shoots whatever is on screen, so **check that the target tab is still active immediately before capturing and skip it otherwise**. If the tab changed during a delayed call, another tab's screen would be stored as this tab's picture.
2. **`og:image` / `twitter:image`**, read and reported by the content script on page load. Content scripts run in background tabs too, so even a tab that was never shown gets a stand-in image.
3. **A favicon card**: a large favicon and the domain name. With no favicon either, a placeholder with the domain's first letter.

Images are downscaled with `OffscreenCanvas` to 420px wide at JPEG quality 0.6, about 30KB each.

**This design has a structural weakness.** The first candidate tends to be "a tab opened in the background and never shown", and such a tab has no screenshot even in principle. The card you most want to see is the one with the least information. Unavoidable.

## 5. Storage

The recency stack and the image cache both live in `chrome.storage.session` (in memory, never persisted to disk).

Persisting to disk would not help: **a browser restart reassigns every tab id**, so nothing could be restored, and the only lasting effect would be JPEGs of browsed pages left on disk. Images are kept for up to 12 tabs (LRU), comfortably inside the 10MB `storage.session` quota.

`storage.session` lives in the browser process, so it survives the service worker shutting down.

**Updates to the recency stack must be serialized.** Storage reads and writes are separate async calls, so opening several background tabs in quick succession makes multiple updates read the same stack and clobber each other (a lost update). That breaks the very point of this extension: a tab that was opened does not become the first candidate. `exclusive()` in `background.ts` funnels every read-modify-write through one promise chain.

## 6. How the overlay is implemented

- **Inject an extension page in an `iframe`.** Drawing into the page DOM with a Shadow DOM means that on sites with a strict `img-src` (GitHub, for instance) **the page's CSP blocks `data:` URL images and no preview appears**. In an iframe the extension's own CSP applies, so it always renders, and page CSS cannot bleed in.
- The iframe is `pointer-events: none` so it never steals interaction from the page (v1 has no mouse operations).
- **Pin `color-scheme` to the same value in three places.** Per `css-color-adjust`, when the **used color scheme of the iframe element** and the **used color scheme of the embedded document's root element** disagree, an opaque Canvas colour is painted instead of a transparent canvas and **the page behind is completely hidden**. This is the specified behaviour, not a Chromium bug, so it will never be fixed upstream.

  What gets compared is **the iframe element, not the page**, so pinning both sides to the same single scheme matches whether the page is light or dark. Put `only dark` in all three of these and keep the values identical:

  1. The iframe element's inline style in `content.ts` (`!important`, so page rules like `iframe { color-scheme: … }` cannot win)
  2. `:root` in `overlay.css`
  3. `<meta name="color-scheme">` in `overlay.html` (applied ahead of the CSS, so the scheme cannot disagree for a moment while loading)

  `only` keeps the browser's forced dark mode from moving it. `dark` rather than `light` because if the canvas ever does show, black blends into the dark panel instead of standing out.

  **Changing only one side cannot guarantee a match.** `normal` does not mean "inherit from the parent iframe" but "use the schemes this document supports", so dropping the overlay's declaration does not necessarily line it up with the iframe element. Putting `inherit` on the iframe element to follow the page fails the same way, because the overlay's root does not follow along. Both were tried in turn and produced black and white respectively. Pages where the two happen to agree show no symptom at all, which is why it surfaces in the misleading form of "it happens on some pages".
- The iframe is created on the first `Ctrl+A` and then kept with `display: none` and reused. It is appended to `document.documentElement`.
- **On close, do not just hide the iframe — send `hide` so the panel itself is hidden too.** The iframe is reused, so without this the panel keeps holding the previous cards. `postMessage` queues its delivery as a posted message task, which allows this order on the next open: send `render` → set the iframe to `display: block` → **a rendering opportunity lands before the `render` task and the previous cards are painted for one frame** → `render` runs and replaces them. When the candidates happen to be the same it goes unnoticed, so it surfaces as a rare flicker.

  The cards are not thrown away. Keeping them preserves decoded images, the next `render` replaces them anyway, and nothing paints while the panel is hidden.
- **Key watching lives in the content script** and focus is never moved into the iframe. Moving focus while `Ctrl` is held is not reliable and would wreck the page's text selection and IME state. The iframe only receives the focus position by `postMessage` and renders.
- postMessage is validated with a random token, since the page can obtain a reference to the iframe and send forged messages. **The token is never in the iframe URL**: the `src` attribute is readable from the page, so it would be no secret. It is delivered in the first message after load, and the overlay adopts only the first token it receives. The page can post into this iframe but cannot read the messages posted to it.

### The key input path

Who handles the second and later `Ctrl+A` presses depends on whether the browser dispatches a registered extension shortcut's key event to the page, which is not guaranteed. Both paths are implemented and the choice is made at runtime.

- Once the content script observes a `Ctrl+A` keydown it sets `localKeyCapable = true` and from then on ignores the `advance` forwarded by the service worker, cycling on its own instead — no round trip, so it keeps up with fast repeats.
- If it never observes one, `localKeyCapable` stays false and the service worker's `commands.onCommand` drives the cycling.
- As a backstop, duplicate `advance` calls within 80ms are coalesced.

### Picking up keys across frames

The content script runs with `all_frames: true` plus `match_about_blank: true` and `match_origin_as_fallback: true`. With focus in an iframe on the page, key events never reach the parent document (events do not cross document boundaries), so the `Ctrl` keyup would be lost. `all_frames` alone does not enter `about:blank` / `srcdoc` / `data:` / `blob:` frames, hence the other two (`match_origin_as_fallback` requires Chrome 119+).

- A child frame's content script relays keydown / keyup to the service worker **via `chrome.runtime`**, and the worker forwards them to `frameId: 0`.
- **Never relay with in-page postMessage.** Page scripts in that frame can both forge and observe it, which means (a) a forged `Control` keyup lets a hostile page switch tabs with no user action, and (b) it becomes a leak channel telling the parent page about `Control` / `Backspace` / `Escape` / `Ctrl+A` typed inside a cross-origin frame. Distributing a shared secret does not help, because the delivery channel itself is observable. Extension messaging can be neither forged nor observed by the page.
- Before `arm`, a child frame relays only the physical `Control` state and
  `Ctrl+A`. The top frame needs those opening signals so a quick tap released
  before `arm` arrives does not leave the overlay open until the safety timeout.
  It does not prevent the page's default handling in this state.
- After `arm`, a child frame relays every overlay key. As a safety net against a
  missed disarm it returns to the opening-signals-only state after 12 seconds.
- A child frame calls `preventDefault()` on every keydown while armed. Otherwise `Backspace` in a text field deletes characters while also cycling backwards.

### Deciding the overlay cannot be opened

Each of these returns `handled: false` and the service worker **toggles instantly to the first candidate**. It must not switch to a bare `ring[1]`: that tab can be closed or moved to another window between listing and switching, so walk down to **the first tab that is still in this window**. Jumping to a moved tab would violate "candidates come from the current window only".

- The target tab's URL uses a scheme that cannot be injected (a page that cannot host the overlay).
- The URL is injectable but `chrome.tabs.sendMessage` fails anyway (the PDF viewer, for example).
- `document.hasFocus()` is false (focus is in the address bar), so no key event would ever arrive.
- `document.fullscreenElement` exists. A `z-index` cannot beat the Fullscreen API top layer, and cycling and committing over invisible cards is worse than not showing them.
- **`Ctrl` was already released before `open` arrived.** The service worker makes several storage reads and tab queries, so tapping `Ctrl+A` and releasing quickly delivers the keyup first. Doing nothing would leave the overlay up until the 10 second safety net fires — and this is the single most frequent operation, so it must always fall through. The content script tracks the timestamps of `Ctrl` keydown and keyup even while the overlay is closed in order to decide this.

### Recovering when the two states disagree

The service worker's overlay state and the content script's `isOpen` can drift apart. An automatic page reload, a full SPA navigation or a renderer crash rebuilds the content script, leaving only the overlay entry in `storage.session`.

- Include `open` in the `advance` response and **check the real state, not whether delivery succeeded**. If `open` is false, drop the overlay state and open again. Without this, `Ctrl+A` stays dead in that tab forever.
- Drop the overlay state on `tabs.onUpdated` with `status === 'loading'` as well.

## 7. Appearance

Matches the reference screenshot.

- **No full-screen dim or blur.** Only the panel floats; the page stays visible behind it.
- Panel: centred, 28px radius, dark grey, a 1px faint border, a strong drop shadow, 22px of inner padding.
- Cards: a single row with an even gap. Thumbnails are 16:10 with a 10px radius and `object-fit: cover`.
- Label: below the thumbnail, an 18px favicon plus one line of title truncated with `text-overflow: ellipsis`.
- **Focus is shown by glow, not by scaling up.** Only the focused card gets a blurred blue-to-purple-to-pink gradient around its edge plus a translucent rounded plate. The label sits inside the glowing area too.
- The panel and cards appear immediately. Focus moves with a 120ms transition.

## 8. Exclusions and opting out

- Disabled entirely in incognito (`incognito: "not_allowed"`). Left as `spanning`, a user allowing incognito would mix JPEGs of incognito tabs into the same memory as the normal context.
- Pinned tabs, tabs in other tab groups and discarded tabs are **all included** as candidates.

## 9. Project layout

TypeScript + esbuild + a hand-written `manifest.json` + Vitest. No UI framework.

```
manifest.json
scripts/build.mjs        esbuild invocation
src/
  types.ts               message types
  recency.ts             pure stack operations (the tested part)
  recency.test.ts
  store.ts               chrome.storage.session wrapper
  capture.ts             captureVisibleTab + downscale
  background.ts          service worker
  content.ts             key watching + iframe injection + child frame relay
  overlay/
    overlay.html
    overlay.css
    overlay.ts           rendering only
```

Distribution is unpacked: `npm run build` produces `dist/`, which is loaded from `chrome://extensions`.

### Lint has exactly one purpose

`eslint.config.mjs` makes `unicorn/no-array-callback-reference` an error and nothing else. Formatting and broad static analysis are out of scope.

Passing a function directly to an array iterator feeds the **array index** into the callback's second parameter. TypeScript intentionally allows using a function with fewer parameters as a callback that takes more, so this slips past the type checker even under `strict`. It actually shipped: `ring.map(toCandidate)` passed the index as `windowId`, every candidate was rejected, and `Ctrl+A` stopped showing cards.

**When adding or changing a function's parameters, check every reference, including those outside the diff.** A signature change alters the meaning of call sites that the diff never shows. The regression above passed a review that only looked at the diff.

## 10. Known weaknesses

1. The first candidate has the weakest preview (section 4).
2. `Ctrl+A` collides with select-all (section 2). Minor on macOS; on Windows / Linux select-all is lost.
3. Right after opening a link in the background, a single `Ctrl+A` moves "forward" to the new tab rather than "back". By design, but it differs from the `Alt+Tab` feel.
4. `file://` cannot be injected by default, so it falls back to an instant toggle.
5. Only the very first switch after a browser restart falls back to tab strip order.
6. Behaviour in Brave needs verifying on a real machine (`Ctrl+A` conflicts, how Shields interacts with iframe injection).
7. During element fullscreen the overlay is skipped in favour of an instant toggle (section 6).
8. **`Ctrl+Shift+A` does not always cycle backwards**, for two overlapping reasons. (a) On Windows / Linux it is assigned to Chrome's tab search and never reaches the page. (b) In browsers that do not dispatch extension shortcut keydowns to the page it never reaches the content script at all, and since `Ctrl+Shift+A` is a different combination from `cycle-forward` it does not fire `commands.onCommand` either. `Backspace` always works, so backwards cycling itself is never lost.
9. Cycling backwards cannot start from a closed overlay, because `Ctrl+Shift+A` is not registered in `commands`. The requirement was backwards cycling *while the overlay is shown*, so this is out of scope.
10. **`W` only closes tabs on macOS** (section 2). On Windows / Linux `Ctrl+W` goes to the browser and the current tab is closed.
11. **The overlay's displayed contents can in theory be forged by the page.** The token arrives in the first message after load, so a page script that wins the race by sending a forged `init` at the same `load` timing could replace the panel's contents. Only the **display** can be forged, never a tab switch: the key path goes through extension messaging, which the page cannot forge. A page can already draw anything over itself, so this does not exceed what it could do anyway.
