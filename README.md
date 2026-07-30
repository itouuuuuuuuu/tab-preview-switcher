# Tab Preview Switcher

A Chrome / Brave extension that switches tabs in **most-recently-opened order** while showing previews.

Hold `Ctrl`, tap the cycle key to move focus, and the moment you release `Ctrl` the switch commits. Until you let go, no tab actually moves.

```
┌──────────────────────────────────────────────┐
│ ┌───┐ ┏━━━━━┓ ┌───┐ ┌───┐ ┌───┐ │
│ │   │ ┃     ┃ │   │ │   │ │   │ │
│ └───┘ ┗━━━━━┛ └───┘ └───┘ └───┘ │
│ current   cand 1    cand 2  cand 3  cand 4  │
└──────────────────────────────────────────────┘
```

## Keys

| Action | Behaviour |
| --- | --- |
| `Ctrl+A` | Opens the overlay with candidate 1 focused. Tap and release to jump to the previous tab |
| `A` again while holding `Ctrl` | Next candidate |
| `Backspace` | Cycle backwards |
| `Ctrl+Shift+A` | Cycle backwards (does not work on Windows / Linux) |
| `W` | Closes the focused tab (macOS only) |
| `Esc` | Cancel and stay on the current tab |
| Release `Ctrl` | Commit to the focused tab |

At most 5 previews including the current tab. Candidates come from the current window only.

Closing with `W` keeps the overlay up and moves the next candidate into the same slot. If another tab is available but not shown yet, it moves up so the count returns to 5 — during the round trip that fetches it there are 4 cards, and if no candidate is left it simply stays at 4. The overlay closes once there is nothing left to switch to.

## Why not `Ctrl+Tab`

Because it cannot be taken.

- `chrome.commands` **dropped Tab from its supported keys in Chrome 33**, so it cannot be bound at all.
- In a content script, `Ctrl+Tab` and `Ctrl+Shift+Tab` are reserved shortcuts: the key event is never dispatched to the renderer and `preventDefault()` is ignored.
- So "hold `Ctrl` and tap `Tab`" is impossible both for opening the overlay and for cycling once it is open. Brave is Chromium, so the same applies.

`Ctrl+A` can be changed to any key you like (see below).

## Switching order

A single stack, moved to the front on **both** `tabs.onActivated` and `tabs.onCreated`.

That means **a tab opened in the background becomes the first candidate even though it was never shown**. Open three links in the background and the last one opened is the first candidate.

```
Viewing tab A, open links B → C → D in the background

  stack:   D C B A
  display: [A] D C B
            ↑    ↑ first candidate
          current
```

## Install

```sh
npm install
npm run build
```

**Chrome**

1. Open `chrome://extensions`
2. Turn on "Developer mode" in the top right
3. Choose "Load unpacked" and pick `dist/`

**Brave**

Same steps, at `brave://extensions`.

## Changing the shortcut

- Chrome: `chrome://extensions/shortcuts`
- Brave: `brave://extensions/shortcuts`

The Tab key cannot be assigned (see above).

## Known limitations

- **Some pages cannot host the overlay.** `chrome://*`, `brave://*`, the new tab page, the Chrome Web Store, extension pages, `view-source:`, the PDF viewer, `file://`. Pressing `Ctrl+A` on those switches straight to the first candidate with no preview. The same happens when focus is in the address bar, and during **element fullscreen** (a fullscreen video, for example), because a `z-index` cannot beat the fullscreen top layer.
- **`Ctrl+A` collides with select-all**, because registering an extension shortcut makes the browser consume the key. On macOS select-all is `Cmd+A`, so the impact is small — only "move to start of line" in text fields. **On Windows / Linux you lose select-all.**
- **`W` only closes tabs on macOS.** On Windows / Linux, `Ctrl+W` is the reserved "close tab" shortcut, so **the browser closes the current tab** before the event reaches the page. The extension cannot intervene.
- **`Ctrl+Shift+A` does not always cycle backwards.** On Windows / Linux it is taken by Chrome's tab search, and it also never arrives in browsers that do not dispatch extension shortcut keydowns to the page. `Backspace` always works, so use that if it feels dead.
- **The first candidate has the weakest preview.** `chrome.tabs.captureVisibleTab()` can only shoot the active tab, so a tab opened in the background and never shown has no screenshot at all. It falls back to `og:image` or a favicon card. Unavoidable.
- **Previews are snapshots from when the tab was last visible.** The current contents of a background tab cannot be captured.
- **Right after opening a link in the background, a single `Ctrl+A` moves "forward" to the new tab rather than "back".** That is by design, but it differs from the `Alt+Tab` feel.
- **Only the very first switch after a browser restart falls back to tab strip order.** A restart reassigns tab ids, so the order cannot be restored.
- **Disabled in incognito** (`incognito: "not_allowed"`), to keep screenshots of incognito tabs out of the same memory as the normal context.
- Candidates come from the current window only. Tabs in other windows are never shown.

## Privacy

Screenshots and the recency stack live only in `chrome.storage.session` (in memory) and are **never written to disk**. They vanish when the browser closes. Images are kept for up to 12 tabs (LRU). Nothing is sent anywhere.

The `<all_urls>` host permission is required because `captureVisibleTab()` needs it.

## Development

```sh
npm run build       # produce dist/
npm run watch       # watch-build the JS (re-run for changes to static files)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (only detects functions passed directly to array iterators)
npm test            # vitest (unit tests for the switching order)
```

[`docs/SPEC.md`](docs/SPEC.md) has the full design and the reasoning behind each decision.

## Troubleshooting

**A manifest error on load**

`"mac": "MacCtrl+A"` under `commands` may have been rejected. Delete the whole `suggested_key` block from `manifest.json`, load it again, and assign the shortcut by hand at `chrome://extensions/shortcuts`.

**`Ctrl+A` does nothing**

1. Check for a shortcut conflict with another extension at `chrome://extensions/shortcuts`.
2. Check whether the page is one of those listed above that cannot host the overlay.
3. Read the service worker log: click "Service Worker" for this extension at `chrome://extensions`.

**A preview is black or missing**

A tab that has never been shown has no screenshot, by design. Show it once and try again.
