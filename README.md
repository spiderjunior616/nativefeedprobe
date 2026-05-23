# Native Feed Bridge

Millennium plugin that feeds local Steam-native activity data into Steam's own app activity renderer.

The goal is to make local activity for jogos Lua appear through Steam's native UI, without publishing those activity events to Steam servers or public profiles.

## What It Does

- Adds local `UserNews`-shaped activity events for configured jogos Lua.
- Uses Steam's native activity feed renderer instead of a custom visual feed.
- Provides local comment and like thread responses for bridge-owned events.
- Reads local achievement data from Steam and uses native achievement metadata when available.
- Stores local first-play observations in `Steam/config/nativefeedprobe-play-state.json`.

## Scope

This plugin is separate from other Steam activity tools.

The implementation depends on Steam's internal web UI and service shapes, which can change between client versions.

## Install

Copy this folder to:

```text
Steam/plugins/nativefeedprobe
```

Then reload Millennium or restart Steam.

## Debug Logging

Debug logging is off by default. In the Steam web UI console, set:

```js
localStorage.setItem("__NativeFeedBridgeDebug", "1")
```

Set it back to `"0"` or remove the key to silence debug logs.
