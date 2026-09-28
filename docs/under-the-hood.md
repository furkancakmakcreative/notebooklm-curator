# Under the hood

Notes for anyone extending the tool or fixing it after a NotebookLM interface change.

## Why browser automation

NotebookLM has no public API for personal accounts. Source lists, publish dates and deletion are
not reachable over HTTP. The Gemini Notebook Enterprise API on Google Cloud is a separate product
that needs an enterprise account.

So the tool drives the website through a persistent Chrome profile. It launches your installed
Google Chrome on purpose, not a downloaded Chromium: patchright's anti-detection patches are far
more effective inside a real Chrome, and NotebookLM does run bot checks. If Chrome is missing,
every tool fails immediately with a clear message instead of a browser-launch stack trace.

Every selector lives in `src/notebooklm.js`. When Google ships a UI change, that is the only file
that should need an update.

## Verification dates

| What | Verified live |
|---|---|
| Notebook grid, source list, remove menu | 2026-07-29 |
| Chat completion signal (`nlm_ask`) | 2026-08-05 |
| Add-source modal, "Websites" option, overlay over the notebook header | 2026-09-18 (Turkish UI) |

The English label of the add-source "Websites" option is matched as `Websites` or `Website`; it was
only verified in Turkish (`Web siteleri`).

## Overlays

Since September 2026 a freshly created notebook opens the add-source modal by itself. Its Material
backdrop (`.cdk-overlay-backdrop`) swallows every click underneath, which broke renaming a new
notebook. `closeOverlays()` presses Escape until the backdrop is gone; create, rename, add and ask
all call it first.

## Adding a source

`addSource()` opens the add-source modal (a new notebook already has it open), picks the Websites
option, types the URL into the modal's own field and presses Enter. NotebookLM imports in the
background, so success is confirmed by the source list growing within 60 seconds, not by the click.
The URL field is looked up inside the overlay container first; a page-wide lookup could type the URL
into the chat box instead.

## How `nlm_ask` knows the answer is done

The obvious approach, polling `document.querySelector('main').innerText` until it stops changing, is
wrong: NotebookLM's chat panel renders outside `<main>`. That text never changes, so the loop reports
"stable" almost instantly and returns whatever sits in `<main>`, in one observed case hidden
emoji-picker markup unrelated to the question.

The reliable signal is the `.thinking-message` element (it carries an `is-changing` class while
streaming) detaching from the DOM. The query box's `disabled` attribute clears slightly after that,
and firing the next question too early hits a disabled box and hangs. `ask()` waits for the box to be
enabled before typing, then for the thinking indicator to detach, then for the box to re-enable,
before reading the last `.chat-message-pair`. If any wait times out, the answer comes back with
`incomplete: true` instead of being presented as final.

`nlm_ask` also keeps a minimum gap (default 4 s, `NLM_MIN_ASK_INTERVAL_MS`) between questions.
Back-to-back questions are a pattern real use never produces and the most plausible trigger for
NotebookLM's occasional refusal to answer. That is cheap insurance, not a confirmed root cause.

## Signing in

`nlm_auth` opens a visible Chrome window. If a background (headless) browser for the same profile is
already running, it is closed first; otherwise the tool would report a window that never appeared.
While the window is on a Google sign-in page, `nlm_auth` never reloads it: reloading under someone who
is typing a password throws the sign-in away. Once signed in, the window is closed and later calls run
headless.

## Keyless YouTube

Without `YOUTUBE_API_KEY`, watches use `https://www.youtube.com/feeds/videos.xml?channel_id=...` or
`?playlist_id=...`. The feed lists the newest 15 videos. An `@handle` is resolved to its `UC...` channel
ID from the public channel page. A cursor that fell off the 15-item feed is not treated as truncation
(that would block the watch forever); new items are deduplicated by video ID anyway. The channel's
uploads playlist ID (`UU...`) is still stored, so adding a key later moves the watch to the Data API
without changes.

## Other known rough edges

- A few fixed `waitForTimeout` calls remain where no reliable DOM signal was found. On a slow
  connection they can under-wait; on a fast one they add latency.
- `removeSource` re-checks the target row's title right before acting, but index-based targeting
  cannot fully rule out the list reordering mid-click.
- The profile directory is created with mode `0o700`, which has no effect on Windows NTFS.
