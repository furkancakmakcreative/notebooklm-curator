# Changelog

## 0.3.0

Made for people who are not developers.

- **One-click install for Claude Desktop.** Every release now ships `notebooklm-curator.mcpb`:
  download, double-click, install. The optional YouTube key is a field in the extension settings.
- **One-command install for Claude Code** through `npx`, no clone needed.
- **`nlm_setup`**: checks Chrome, Google sign-in, the optional YouTube key and watches, and returns
  plain-language next steps. The server also tells Claude to lead new users through setup.
- **YouTube API key is now optional.** Without it, channel watches read YouTube's public feed (newest
  15 videos, with a warning when more may have been missed), and audits still categorize sources and
  find duplicates. Publish dates, full channel history and playlists longer than 15 videos need a key.
- **Sign-in fixes.** `nlm_auth` no longer reports a window that never opened when a background browser
  held the profile, never reloads the page while someone is signing in, and closes the window once
  signed in. Every other tool now says "run nlm_auth" instead of timing out when signed out.
- **NotebookLM interface fixes** (flow verified live on 2026-09-18): new notebooks open the add-source
  modal by itself and its backdrop blocked renaming; overlays are now closed first. Adding a source
  picks the Websites option, types into the modal's own field, and is confirmed by the source list
  growing instead of assumed after four seconds. Renames are checked again after a reload. `nlm_ask` waits
  for the query box to be enabled before typing.
- **Watch fixes.** A new playlist watch records the videos already in the playlist, so the first sync
  no longer queues the whole playlist as new. A link that was submitted to NotebookLM but not
  confirmed becomes `uncertain` instead of being retried into a duplicate. Browser relaunches no longer
  race with background checks, and a missing Chrome no longer blocks the account until restart.
- **Fixed:** the server exited silently when started through a symlink, which is how `npx` and global
  installs run it on macOS and Linux. Same fix for the sync CLI.
- **Security:** dependency updates clear three advisories (fast-uri, hono, qs). `npm audit` reports 0.
- **Docs:** README rewritten around installing and using the tool, Turkish guide added, technical notes
  moved to `docs/under-the-hood.md`. Removed an inaccurate comparison with other NotebookLM MCP servers.
- CI on Windows, macOS and Linux; a release workflow builds and attaches the extension.

## 0.2.1

- Hardened recovery for watched sources: an add interrupted by a crash becomes `uncertain` and needs
  an explicit `mark-added` or `retry-add` decision.

## 0.2.0

- Watched YouTube sources: follow channels and playlists, review or automatically add new videos
  within a notebook's source limit, startup catch-up and a one-shot sync command for schedulers.

## 0.1.0

- First public release: list, audit by shelf life, and safely remove NotebookLM sources; create and
  rename notebooks, add sources, ask questions.
