# Native Community RPC notes

Scope: isolated `nativefeedprobe` plugin.

## 2026-05-23 - own first-play state v1

- Added backend-owned local first-play state in `config/nativefeedprobe-play-state.json`.
- `GetLuaGameTimes` now records a baseline only when an app is probed directly, not during manifest preload.
- If a later probe sees playtime move from zero to played, the backend stores `ownFirstPlayedAt` with `observed` confidence and never overwrites it.
- Imported/estimated first-play values are still exposed separately, but the UI bridge only prefers the owned value when confidence is `observed`.
- The frontend invalidates cached app timing if Steam reports a changed `LastPlayed`, so the backend can capture the transition after a play session.

## Steam UI call path found

The native app activity renderer builds `UserNews` events in `AppActivityStore`. For comment/like UI it creates comment thread type `16` for activity events:

- `AchievementUnlocked` => event type `2`
- `ReceivedNewGame` => event type `3`
- `PlayedGameFirstTime` => event type `30`

The Steam UI generated Community service methods are in `steamui/chunk~2dcc5aaf7.js`, module `10812`:

- `Community.GetCommentThread#1`
- `Community.PostCommentToThread#1`
- `Community.RateCommentThread#1`
- `Community.DeleteCommentFromThread#1`

The native thread store is in module `3963`, export `Nb.ThreadStore`. It calls the Community service above through `CMInterface.GetServiceTransport()`.

## Local bridge approach in 1.0.3

`public/nativefeedprobe.js` now patches the generated Community service methods before they reach Steam's service transport, but only for local bridge thread keys created by this plugin. The older `ThreadStore` fallback is also limited to those known local keys.

This is intentionally narrower than a DLL hook:

- no server publish
- no public profile/accounting
- no stable plugin changes
- no game launch required
- still uses Steam's native renderer and native thread UI

Local comments and likes persist in `localStorage` under `__NativeFeedBridgeState_v2`.

## Expected validation

After restarting Steam or reloading the plugin context, navigate to a game with local bridge events and look for:

- `[Native Feed Bridge] patched native Community comment service with local bridge responses`
- `[Native Feed Bridge] served local Community.GetCommentThread#1`
- no new `Failed to fetch past comments: eresult 2` for those local bridge thread keys

Visual validation still needs a screenshot from Steam because the renderer is native Steam UI.

## Validation on 2026-05-20

Steam was restarted and the plugin loaded with marker `__NativeFeedBridgeStarted_20260520_native_store_bridge_v4`.

Confirmed in `webhelper_js.txt`:

- `hasCommunityService: true`
- `patched native Community comment service with local bridge responses`
- local `Community.GetCommentThread#1` responses for activity threads
- no new comment-thread `eresult 2` after the v4 marker

Additional controlled DevTools validation in `SharedJSContext` called the patched service directly for a known local thread:

- `GetCommentThread#1` returned `EResult 1`
- `PostCommentToThread#1` returned `EResult 1`
- `RateCommentThread#1` up/down returned `EResult 1`
- `DeleteCommentFromThread#1` returned `EResult 1`
- final comment total returned to `0`

No game process was launched during this validation.

## Hardening in 1.0.4

The bridge now waits for `AppActivityStore` to stabilize before repairing local data and only runs when the backend confirms the app has a local jogos Lua script in `config\stplug-in`.

Fixes added after inconsistent visual output:

- removed the fallback that bridged arbitrary Steam overview apps
- clamps an impossible `PlayedGameFirstTime` time when it is newer than the first unlocked achievement
- deletes only local `AppActivityStore` events for impossible first-play entries before adding the corrected local event
- groups achievements deterministically by local calendar day and injects one native `AchievementUnlocked` event per day with all achievement ids
- repairs partial or split achievement-day rows by deleting local rows for that day and re-adding the grouped native event
- logs before/after snapshots of simple and achievement events for easier visual/debug comparison

This is still isolated to `nativefeedprobe`.

## Hardening in 1.0.5

The Community service shim is installed immediately after the Steam webpack modules are captured, instead of waiting for the delayed per-app bridge run. This avoids the native comment UI racing ahead and hitting Steam's server path before local comment/like handling is patched.

## Hardening in 1.0.6

The per-app bridge now starts almost immediately after the app detail sections are observed. It also performs the first-play sanity repair before waiting for the activity store to settle, then repeats the sanity check after stabilization. This reduces the window where Steam can briefly render a stale cached `PlayedGameFirstTime` row.

## Hardening in 1.0.7

The plugin patches `AppActivityStore.GetAppActivity` with a small local sanitizer. When a corrected first-play timestamp is already persisted in local bridge state, stale cached `PlayedGameFirstTime` rows newer than that timestamp are deleted locally before the native UI reads the activity object.

## Hardening in 1.0.8

The achievement bridge now treats `0` rarity from Steam as missing rarity instead of a real percentage. Steam's native tooltip clamps an existing `flAchieved: 0` to `0.1%`, so the plugin omits `flAchieved` when Steam does not provide a positive global unlock percentage.

The bridge also refreshes existing in-memory native achievement events after updating `m_AchievementMap`, so older grouped rows created before the rarity map was ready can pick up correct Steam percentages without needing a regroup.

## Hardening in 1.0.9

Some games expose global achievement percentages through Steam's public `GetGlobalAchievementPercentagesForApp` endpoint while the native client `AchievementStore` returns zeros or no percentages. The plugin now uses that public Steam endpoint as a read-only fallback and merges only missing percentages into the native achievement map.

This fallback does not publish events, comments, likes, achievements, or stats. It only reads public global percentages and still lets Steam's native activity renderer display the feed.

## Hardening in 1.0.10

The public global percentage fallback is also applied back into Steam's in-memory `AchievementStore` result objects and global percentage map. This gives the native achievements page the same percentage data used by the activity feed when the client store initially returned blank rarity values.

## Hardening in 1.0.11

Achievement rows now treat rarity as part of the readiness check. If a native grouped achievement event already exists with the right ids and time but its achievement objects are missing or carrying stale rarity values, the plugin deletes and re-adds that local row using the already-populated achievement map. This avoids relying on in-place mutation of an event object that the React view may have already rendered.

## Hotfix in 1.0.12

The 1.0.11 delete/re-add path can leave a Steam local tombstone for the same achievement event time, making the achievement activity row disappear even though `AddUserNewsEvent` returns successfully. The plugin now preserves any visible achievement group that already has the right ids and repairs rarity in place.

When an achievement group is missing and must be recreated, the bridge verifies that Steam kept the row in `AppActivityStore`. If the exact original timestamp is rejected, it retries with a small same-day timestamp offset instead of reporting success for an event Steam discarded.

## Hotfix in 1.0.13

Rows affected by repeated local re-add attempts can accumulate duplicate achievement objects behind the same visible event. The bridge now deduplicates achievement objects by achievement id while refreshing rarity in place, so a restored event does not carry repeated internal achievement entries.

## Hotfix in 1.0.14

The bridge now lets the local jogos Lua install timestamp override older generic Steam overview timestamps saved by earlier builds. This repairs cases where `adicionou à biblioteca` was pushed to an old generic date and effectively disappeared from the expected part of the activity feed.

For `ReceivedNewGame`, the plugin now verifies that the desired simple event exists at the chosen timestamp and repairs older mismatched local rows before adding the corrected one.

## Hotfix in 1.0.15

Steam groups `ReceivedNewGame` rows by user/day and stores the affected games in `GetAppIds()` instead of a single `gameid`. The bridge now matches events by membership in that appid list, so grouped `adicionou a biblioteca` rows are detected, verified, and preserved instead of being treated as missing.

## Hotfix in 1.0.16

Steam does not deduplicate appids inside grouped `ReceivedNewGame` rows. Repeated repair attempts could therefore render duplicate capsules and headlines like `adicionou 21 coisas a biblioteca`. The bridge now deduplicates those grouped appid lists in the activity sanitizer before the UI reads them, and removes only the target appid from mismatched grouped rows instead of deleting unrelated grouped data.

## Hotfix in 1.0.17

The bridge now runs each app pass more atomically: it waits for Steam's activity object to settle, prepares local simple events and achievement groups, defers intermediate `RequestStoreItems`/`SortEvents` calls, and refreshes the native activity store once at the end. It also applies a short per-app cooldown so repeated `GetSections` renders do not trigger back-to-back bridge passes while the user is watching the page.

## Hotfix in 1.0.18

The final native activity refresh is now skipped when a bridge pass only confirms existing rows and does not make a visible local change. The per-app rerun cooldown was increased, and the completion log was shortened so the important refresh/change counters are visible before Steam truncates long log lines.

## Response merge in 1.0.19

The plugin now patches Steam's generated `UserNews.GetUserNews#1` service and merges local jogos Lua events into the protobuf response before Steam's native activity store consumes it. This is still a JS/Millennium-level interception, not a DLL transport hook.

The merge is deliberately bounded: local game detection gets a short timeout, achievement data waits only briefly, and missing achievement/rarity data falls back to the older post-load bridge. First-play events are not introduced from a raw backend timestamp unless achievement sanity or prior local state is available.

## Response merge preload in 1.0.20

The backend now exposes a startup manifest of all local jogos Lua scripts and their cached local times. The frontend loads that manifest once, so `UserNews.GetUserNews#1` can usually decide whether an app is local without calling the backend during the feed response.

When Steam observes a game page, the plugin prewarms the local UserNews plan for that app before the native feed response arrives. The older AppActivityStore bridge is delayed slightly and behaves more like a fallback/verifier when the response merge already supplied the rows.

## Response merge hardening in 1.0.21

The UserNews response merge now also appends Steam's `achievement_display_data` payload for local achievement events. For games whose native client achievement cache is missing global rarity percentages, the response path performs a bounded read-only public global percentage fetch before returning the merged UserNews response.

The goal is to let Steam's native renderer receive `unlocked_pct` with the initial feed payload, so rare achievement frames can render on first paint instead of appearing several seconds later after the fallback bridge repairs the in-memory activity objects.

## Hotfix in 1.0.22

The response prewarm now also primes any already-cached `AppActivityStore` achievement rows with the freshly loaded rarity map before the fallback bridge runs. This covers the case where Steam displays older local cached rows while the merged UserNews response is still being processed.

## Hotfix in 1.0.23

The initial rarity path now preserves achievement icon metadata instead of replacing it with incomplete data from the fast achievement cache. `achievement_display_data.icon` is sent as Steam's expected app-relative icon token, while `AppActivityStore` keeps a full image URL for native rendering.

If an icon token cannot be resolved, that achievement is skipped from the display-data payload rather than poisoning Steam's native achievement map with blank gray icons.

## Hotfix in 1.0.24

Local native-feed comments now preserve the raw typed text but return a Steam BBCode-compatible display string for ASCII emoticon shortcuts such as `:steamfacepalm:`.

Steam's activity comment renderer calls `FormatAndParseUserStatusBBCode`, which only expands Steam's internal emoticon delimiter or an explicit `[emoticon]...[/emoticon]` tag. The bridge now converts local `:name:` tokens to that native tag before the comment reaches the renderer, so existing local comments can render emoticons without waiting on the async emoticon list.

## Publication hardening in 1.0.25

The plugin is quieter and safer for public source release:

- debug logs are disabled by default and can be enabled with `localStorage.__NativeFeedBridgeDebug = "1"`
- runtime log payloads redact Steam IDs, account IDs, tokens, sessions, and filesystem paths
- backend endpoints validate `appid` bounds before reading local metadata or calling public Steam APIs
- backend error responses no longer return raw exception text that could include local filesystem details
- the webkit shim no longer hardcodes an absolute local plugin path
