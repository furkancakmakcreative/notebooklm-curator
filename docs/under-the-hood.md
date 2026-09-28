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
The URL is only ever typed into a field inside the overlay container; a page-wide lookup could hit the
chat box, and Enter would send the link as a question. If the Websites option or the field is missing,
nothing is typed and `submitted: false` is returned. Once the link was sent, a missing confirmation is
`submitted: true`: watches mark such a candidate `uncertain` instead of retrying, because NotebookLM may
still import it and a retry would create a duplicate.

## Renaming

The new title is typed, Enter is sent to the title field itself (a modal's focus trap would otherwise
take it), and the page is reloaded before the title is read back. Reading the field without a reload
would only return the text just typed.

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
While a browser closes, its slot holds the closing promise, so a background check that arrives at that
moment waits instead of launching a second Chrome against the still-locked profile.
While the window is on a Google sign-in page, `nlm_auth` never reloads it: reloading under someone who
is typing a password throws the sign-in away. Once signed in, the window is closed and later calls run
headless.

## Keyless YouTube

Without `YOUTUBE_API_KEY`, watches use `https://www.youtube.com/feeds/videos.xml?channel_id=...` or
`?playlist_id=...`. The feed lists the newest 15 videos. An `@handle` is resolved to its `UC...` channel
ID from the public channel page. When the last seen video is no longer in the feed (deleted, made
private, or more than 15 uploads since the last check), only videos published after the last successful
check (minus six hours of slack, never before the watch was created) count as new, and a warning is
returned when the whole feed is newer than that point. This is not reported as truncation, which would
block the watch forever. Playlist feeds list a playlist's first 15 entries in playlist order, so keyless
playlist watches only see additions within those. A new playlist watch stores the IDs already in the
playlist (`seenVideoIds`) so the first full rescan does not queue them. The channel's
uploads playlist ID (`UU...`) is still stored, so adding a key later moves the watch to the Data API
without changes.

## Other known rough edges

- A few fixed `waitForTimeout` calls remain where no reliable DOM signal was found. On a slow
  connection they can under-wait; on a fast one they add latency.
- `removeSource` re-checks the target row's title right before acting, but index-based targeting
  cannot fully rule out the list reordering mid-click.
- The profile directory is created with mode `0o700`, which has no effect on Windows NTFS.
