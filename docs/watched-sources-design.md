# Watched Sources design

Status: implementation contract for the first release

## Product boundary

The first release watches YouTube channels and playlists, discovers new videos incrementally,
deduplicates them by canonical video ID, and optionally adds eligible videos to a target notebook.
It is not a general web crawler, hosted service, notification platform, or transcript pipeline.

The safe default is review mode. Nothing removes NotebookLM sources. Adding a watch does not import
the channel's existing archive unless the caller explicitly asks for a bounded initial item count.

## Runtime shape

One shared sync engine serves three entry points:

- MCP tools for interactive use.
- A one-shot CLI command suitable for Windows Task Scheduler or cron.
- A non-blocking startup catch-up check after the MCP server connects.

The MCP process is not itself a long-lived scheduler. A missed local schedule is safe: the next run
uses persisted cursors and canonical video IDs to discover everything added since the last success.

## Persistence

State lives below the existing `NLM_DATA_DIR` convention, separately for each account:

```text
<data-dir>/accounts/<account>/watch-state.json
```

The store must:

- validate account slugs with the same flat character policy as browser profiles;
- initialize an empty versioned document;
- write through a temporary file and atomic rename;
- serialize in-process updates;
- use a bounded lock file so CLI and MCP writes cannot overlap;
- recover cleanly from a stale lock;
- reject malformed or unsupported state versions instead of silently discarding data;
- allow the state path and clock to be injected in tests.

Schema version 1 contains:

```json
{
  "version": 1,
  "watches": {},
  "candidates": {},
  "lastStartupCheckAt": null
}
```

Watch IDs and candidate IDs are opaque stable strings generated locally. Candidate uniqueness is
provider based: `youtube:<videoId>`. A candidate discovered by two watches is stored once per watch,
because its target notebook and policy can differ.

## Watch record

Required fields:

- `id`
- `account`
- `kind`: `youtube-channel` or `youtube-playlist`
- `inputUrl`
- `canonicalId`: channel ID or playlist ID
- `uploadsPlaylistId`: channel watches only
- `title`
- `notebookId`
- `mode`: `report`, `review`, or `auto`
- `enabled`
- `intervalHours`, default 48, minimum 1
- `sourceLimit`, default 50, configurable for paid plans
- `reserveSlots`, default 5, never negative and always below `sourceLimit`
- `minAutoAddAgeHours`, default 72
- `cursorVideoId`
- `createdAt`
- `lastAttemptAt`
- `lastSuccessAt`
- `lastError`

`report` and `review` both persist candidates so they are not rediscovered. Review candidates are
eligible for later approval. Report mode never adds automatically. Auto mode may add only after all
capacity and age checks pass, and enabling persistent auto mode requires an explicit
`confirmAuto: true` acknowledgement.

## Candidate record

Required fields:

- `id`
- `watchId`
- `sourceKey`: `youtube:<videoId>`
- `videoId`
- canonical watch URL
- `title`
- `channelId`
- `channelTitle`
- `publishedAt`
- `discoveredAt`
- `status`: `reported`, `pending`, `retry`, `adding`, `uncertain`, `added`, or `ignored`
- `attempts`
- `nextAttemptAt`
- `lastError`
- `addedAt`

Retries use bounded exponential delays and never create another candidate for the same watch and
video. Explicit approval may attempt a young video; automatic mode waits until
`minAutoAddAgeHours`. Failed NotebookLM additions become `retry`, not `added`. An expired add claim
becomes `uncertain` and is never retried or marked as added automatically. Because NotebookLM does
not expose source URLs, title equality is not identity proof. Explicit approval must choose either
`uncertainAction: "mark-added"` after confirming the source exists, or
`uncertainAction: "retry-add"` after confirming it does not.

## YouTube discovery

Use the official YouTube Data API.

Channel inputs accepted in the first release:

- `https://www.youtube.com/channel/UC...`
- `https://www.youtube.com/@handle`
- `@handle`
- a raw `UC...` channel ID

Playlist inputs accepted:

- a YouTube URL containing a `list` parameter;
- a raw playlist ID.

Ambiguous legacy custom-channel URLs fail clearly instead of using title search. Channel resolution
uses `channels.list(part=snippet,contentDetails)` with `id` or `forHandle`. Incremental discovery uses
the channel's uploads playlist or the configured playlist with `playlistItems.list`, 50 items per
page. Pagination stops at the persisted cursor or at a conservative page limit. Manifest dedupe is
the final protection if a cursor disappears because a playlist was reordered or an item was removed.
Cursor comparison and `newestVideoId` use the raw playlist item video ID before private/deleted
placeholders are filtered, so an inaccessible item cannot hide the pagination boundary.

Initial watch creation baselines the current newest video. `initialItems` defaults to 0 and is capped
at 50. When non-zero, only that many recent items become candidates.

The existing audit title-resolution API remains compatible. Its quota text and arithmetic must be
updated to the current API model: search calls are counted as calls, while general list-method quota
units are reported separately. Existing response keys may be retained for compatibility but must not
claim that every search call costs 100 general quota units.

## Sync engine

The engine accepts injected YouTube, state, clock, and NotebookLM adapters so unit tests never open a
browser or call the network.

For each due enabled watch:

1. Mark `lastAttemptAt`.
2. Discover items newest first until the cursor or page bound.
3. Insert unseen candidates oldest first so NotebookLM ordering is predictable.
4. Advance the cursor only after discovery and state persistence succeed.
5. In auto mode, process eligible candidates sequentially.
6. Before every automatic add, obtain the current notebook source count.
7. Serialize additions per notebook, suppress a source already added by another watch, and recheck
   capacity while holding the notebook-level manifest claim.
8. Stop when `sourceCount >= sourceLimit - reserveSlots` and leave candidates queued.
9. Persist each add result independently.
10. Mark `lastSuccessAt` and advance the cursor only when discovery completes without truncation.

One watch failing must not abort other watches. The result is compact structured data with counts,
watch-level errors, capacity stops, and candidate IDs.

## Startup catch-up

After the MCP transport connects, schedule a non-blocking check with a short delay. It reads state and
runs only watches whose `lastSuccessAt` is absent or older than `intervalHours`. Errors go to stderr
through the existing sanitization boundary and do not stop MCP startup.

Startup catch-up may perform browser work only for auto-mode candidates. Report and review discovery
need only the YouTube API key.

## MCP contract

The first release exposes five tools:

- `nlm_watch_source`: resolve and add a channel or playlist watch; `auto` requires
  `confirmAuto:true`.
- `nlm_manage_watches`: list, pause, resume, update policy fields, or remove a watch.
- `nlm_sync_watches`: run due watches or force a specific/all watch sync.
- `nlm_list_candidates`: filter candidates by watch and status.
- `nlm_approve_candidates`: require `confirm:true`, then add selected candidate IDs sequentially;
  uncertain candidates additionally require `uncertainAction`.

Watch removal deletes only curator tracking state. It never removes a NotebookLM source. Candidate
approval must enforce notebook capacity immediately before each add.

## CLI contract

Keep `notebooklm-curator` as the MCP stdio executable. Add a second binary,
`notebooklm-curator-sync`, plus an npm `sync` script. The CLI performs one run, prints compact JSON,
sets a non-zero exit code only for a top-level configuration/state failure, closes the browser, and
exits. Individual watch failures remain in the structured result so other watches can finish.

## Testing and compatibility

Use Node's built-in test runner. Tests must cover:

- empty initialization, atomic updates, lock contention, and stale locks;
- channel and playlist parsing/resolution;
- incremental pagination, cursor handling, ordering, and duplicate suppression;
- initial baseline behavior;
- due-time and missed-run catch-up logic;
- report, review, and auto modes;
- age gating, capacity stops, retry state, and partial failures;
- MCP argument validation for arrays, integers, and enums;
- CLI exit behavior without browser/network access through injected adapters where practical.

Existing audit, source removal, ask, authentication, and notebook tools must remain behaviorally
compatible. No new runtime dependency is required for the first release.

## Git and attribution

Subagents do not commit or push. Final commits retain the configured human author and committer.
Commit messages contain no AI, Claude, Anthropic, Codex, model, or co-author attribution trailers.
