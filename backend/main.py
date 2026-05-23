import json
import os
import re
import struct
import threading
import urllib.request
from datetime import datetime, timezone, timedelta
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple, Iterable

import Millennium  # type: ignore

MAX_TEXT_FILE_BYTES = 16 * 1024 * 1024
MAX_APPID = 0xFFFFFFFF
MIN_REAL_TIMESTAMP = 31536000
PLAY_STATE_FILENAME = "nativefeedprobe-play-state.json"
_PLAY_STATE_LOCK = threading.RLock()
_PLAY_STATE_CACHE: Optional[Dict[str, Any]] = None

MONTH_NAMES = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}

TZ_OFFSETS = {
    "UTC": 0,
    "GMT": 0,
    "EST": -5 * 60 * 60,
    "EDT": -4 * 60 * 60,
    "BRT": -3 * 60 * 60,
}

class Plugin:
    def _load(self):
        print("[Native Feed Bridge] Python backend loaded successfully")
        Millennium.ready()

    def _unload(self):
        print("[Native Feed Bridge] Python backend unloaded")

plugin = Plugin()

def _steam_path() -> str:
    try:
        return Millennium.steam_path() or ""
    except Exception:
        return ""

def _now_unix() -> int:
    return int(datetime.now(timezone.utc).timestamp())

def _play_state_path() -> str:
    steam_path = _steam_path()
    if not steam_path:
        return ""
    return os.path.join(steam_path, "config", PLAY_STATE_FILENAME)

def _empty_play_state() -> Dict[str, Any]:
    return {"version": 1, "apps": {}}

def _normalize_play_state(data: Any) -> Dict[str, Any]:
    if not isinstance(data, dict):
        return _empty_play_state()
    apps = data.get("apps")
    if not isinstance(apps, dict):
        apps = {}
    return {
        "version": int(data.get("version", 1) or 1),
        "apps": apps,
    }

def _load_play_state_unlocked() -> Dict[str, Any]:
    global _PLAY_STATE_CACHE
    if _PLAY_STATE_CACHE is not None:
        return _PLAY_STATE_CACHE

    path = _play_state_path()
    if not path or not os.path.exists(path):
        _PLAY_STATE_CACHE = _empty_play_state()
        return _PLAY_STATE_CACHE

    try:
        if os.path.getsize(path) > MAX_TEXT_FILE_BYTES:
            _PLAY_STATE_CACHE = _empty_play_state()
            return _PLAY_STATE_CACHE
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            _PLAY_STATE_CACHE = _normalize_play_state(json.load(handle))
    except Exception:
        _PLAY_STATE_CACHE = _empty_play_state()
    return _PLAY_STATE_CACHE

def _save_play_state_unlocked(state: Dict[str, Any]) -> None:
    path = _play_state_path()
    if not path:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(_normalize_play_state(state), handle, ensure_ascii=True, indent=2, sort_keys=True)
    os.replace(tmp_path, path)

def _int_or_zero(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0

def _assign_if_changed(target: Dict[str, Any], key: str, value: Any) -> bool:
    if target.get(key) == value:
        return False
    target[key] = value
    return True

def _own_first_play_for_app(
    appid: int,
    is_lua_game: bool,
    last_played: int,
    playtime_minutes: int,
    estimated_first_played: int,
    update_state: bool,
) -> Dict[str, Any]:
    if not is_lua_game:
        return {}

    with _PLAY_STATE_LOCK:
        state = _load_play_state_unlocked()
        apps = state.setdefault("apps", {})
        key = str(appid)
        record = apps.get(key)
        if not isinstance(record, dict):
            record = {}
            if update_state:
                apps[key] = record

        existing_first = _int_or_zero(record.get("firstPlayedAt"))
        changed = False
        now = _now_unix()

        if update_state:
            prior_playtime = _int_or_zero(record.get("lastObservedPlaytimeMinutes"))
            prior_last_played = _int_or_zero(record.get("lastObservedLastPlayedAt"))
            had_prior_observation = bool(record.get("firstSeenAt") or record.get("lastObservedAt"))

            changed |= _assign_if_changed(record, "firstSeenAt", _int_or_zero(record.get("firstSeenAt")) or now)
            if (
                not record.get("lastObservedAt")
                or prior_last_played != int(last_played or 0)
                or prior_playtime != int(playtime_minutes or 0)
            ):
                changed |= _assign_if_changed(record, "lastObservedAt", now)
                changed |= _assign_if_changed(record, "lastObservedLastPlayedAt", int(last_played or 0))
                changed |= _assign_if_changed(record, "lastObservedPlaytimeMinutes", int(playtime_minutes or 0))

            if not existing_first and last_played > MIN_REAL_TIMESTAMP and playtime_minutes > 0:
                source = "imported-localconfig-estimate"
                confidence = "imported"
                first_candidate = int(estimated_first_played or 0)

                if had_prior_observation and prior_playtime <= 0:
                    source = "observed-first-play"
                    confidence = "observed"
                    if prior_last_played > MIN_REAL_TIMESTAMP and prior_last_played <= last_played:
                        first_candidate = prior_last_played

                if first_candidate <= MIN_REAL_TIMESTAMP:
                    first_candidate = last_played

                changed |= _assign_if_changed(record, "firstPlayedAt", int(first_candidate))
                changed |= _assign_if_changed(record, "firstPlayedSource", source)
                changed |= _assign_if_changed(record, "firstPlayedConfidence", confidence)
                changed |= _assign_if_changed(record, "firstPlayedCapturedAt", now)
                changed |= _assign_if_changed(record, "capturedLastPlayedAt", int(last_played or 0))
                changed |= _assign_if_changed(record, "capturedPlaytimeMinutes", int(playtime_minutes or 0))

            if changed:
                _save_play_state_unlocked(state)

        first_played_at = _int_or_zero(record.get("firstPlayedAt"))
        return {
            "ownFirstPlayedAt": first_played_at,
            "ownFirstPlayedSource": str(record.get("firstPlayedSource", "") or ""),
            "ownFirstPlayedConfidence": str(record.get("firstPlayedConfidence", "") or ""),
            "ownFirstPlayedCapturedAt": _int_or_zero(record.get("firstPlayedCapturedAt")),
        }

def _stplug_paths(appid: int) -> Tuple[str, str]:
    steam_path = _steam_path()
    stplug_dir = os.path.join(steam_path, "config", "stplug-in")
    return (
        os.path.join(stplug_dir, f"{appid}.lua"),
        os.path.join(stplug_dir, f"{appid}.lua.disabled"),
    )

def _stplug_dir() -> str:
    return os.path.join(_steam_path(), "config", "stplug-in")

def _lua_script_info(appid: int) -> Dict[str, Any]:
    enabled_path, disabled_path = _stplug_paths(appid)
    for path, enabled in ((enabled_path, True), (disabled_path, False)):
        if os.path.exists(path):
            return {
                "exists": True,
                "enabled": enabled,
                "path": path,
                "mtime": os.path.getmtime(path),
            }
    return {"exists": False, "enabled": False, "path": "", "mtime": 0}

def _file_signature(path: str) -> Tuple[int, int]:
    try:
        stat = os.stat(path)
        return int(stat.st_mtime_ns), int(stat.st_size)
    except Exception:
        return 0, -1

@lru_cache(maxsize=128)
def _read_text_file_cached(path: str, mtime_ns: int, size: int) -> str:
    if size < 0 or size > MAX_TEXT_FILE_BYTES:
        return ""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            return handle.read()
    except Exception:
        return ""

def _read_vdf(path: str) -> Dict[str, Any]:
    content = _read_text_file_cached(path, *_file_signature(path))
    return _parse_vdf_simple(content) if content else {}

def _parse_vdf_simple(content: str) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    stack: List[Dict[str, Any]] = [result]
    current_key: Optional[str] = None

    tokens: List[str] = []
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        tokens.extend(re.findall(r'"(?:\\.|[^"])*"|\{|\}', line))

    for raw_token in tokens:
        if raw_token == "{":
            if current_key:
                child: Dict[str, Any] = {}
                stack[-1][current_key] = child
                stack.append(child)
                current_key = None
            continue

        if raw_token == "}":
            if len(stack) > 1:
                stack.pop()
            current_key = None
            continue

        token = raw_token[1:-1].replace(r"\"", '"') if raw_token.startswith('"') else raw_token
        if current_key is None:
            current_key = token
        else:
            stack[-1][current_key] = token
            current_key = None

    return result

def _current_account_ids() -> List[str]:
    steam_path = _steam_path()
    loginusers_path = os.path.join(steam_path, "config", "loginusers.vdf")
    data = _read_vdf(loginusers_path)
    users = data.get("users", {})
    if not isinstance(users, dict):
        return []

    ids: List[str] = []
    for steamid, user_data in users.items():
        if not isinstance(user_data, dict):
            continue
        if str(user_data.get("MostRecent", "0")) != "1":
            continue
        try:
            ids.append(str(int(steamid) & 0xFFFFFFFF))
        except Exception:
            continue

    return ids

def _current_user_ids() -> List[str]:
    account_ids = _current_account_ids()
    steam_path = _steam_path()
    userdata_dir = os.path.join(steam_path, "userdata")
    if not os.path.isdir(userdata_dir):
        return account_ids

    try:
        candidates = [name for name in os.listdir(userdata_dir) if name.isdigit()]
    except Exception:
        return account_ids

    ordered: List[str] = []
    for account_id in account_ids + candidates:
        if account_id not in ordered:
            ordered.append(account_id)
    return ordered

def _localconfig_apps(user_ids: Optional[Iterable[str]] = None) -> Dict[str, Dict[str, Any]]:
    steam_path = _steam_path()
    for user_id in user_ids or _current_user_ids():
        path = os.path.join(steam_path, "userdata", user_id, "config", "localconfig.vdf")
        data = _read_vdf(path)
        apps = (
            data.get("UserLocalConfigStore", {})
            .get("Software", {})
            .get("Valve", {})
            .get("Steam", {})
            .get("apps", {})
        )
        if isinstance(apps, dict) and apps:
            return apps
    return {}

def _safe_times(path: str) -> List[float]:
    times: List[float] = []
    for getter in (os.path.getctime, os.path.getmtime):
        try:
            value = float(getter(path))
        except Exception:
            continue
        if value > 31536000:
            times.append(value)
    return times

def _parse_lua_created_timestamp(path: str) -> int:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            header = "\n".join(handle.readline() for _ in range(12))
    except Exception:
        return 0

    match = re.search(
        r"Created:\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+"
        r"(\d{1,2}):(\d{2}):(\d{2})\s+([A-Z]{2,4})",
        header,
        re.I,
    )
    if not match:
        return 0

    month = MONTH_NAMES.get(match.group(1).lower())
    if not month:
        return 0

    tz_name = match.group(7).upper()
    offset = TZ_OFFSETS.get(tz_name)
    if offset is None:
        offset = 0

    try:
        created = datetime(
            int(match.group(3)),
            month,
            int(match.group(2)),
            int(match.group(4)),
            int(match.group(5)),
            int(match.group(6)),
            tzinfo=timezone(timedelta(seconds=offset)),
        )
        return int(created.timestamp())
    except Exception:
        return 0

def _lua_game_times_for_app(
    appid_int: int,
    apps_cache: Optional[Dict[str, Dict[str, Any]]] = None,
    update_play_state: bool = True,
) -> Dict[str, Any]:
    lua_info = _lua_script_info(appid_int)
    is_lua_game = bool(lua_info.get("exists"))

    library_added_at = 0
    first_played_at = 0
    last_played = 0
    playtime_minutes = 0

    if is_lua_game:
        lua_path = str(lua_info.get("path", "") or "")
        if lua_path and os.path.exists(lua_path):
            timestamp = float(_parse_lua_created_timestamp(lua_path))
            if timestamp <= 0:
                times = _safe_times(lua_path)
                timestamp = min(times) if times else 0
            if timestamp > 0:
                library_added_at = int(timestamp)

        app_data = (apps_cache or _localconfig_apps()).get(str(appid_int), {})
        if isinstance(app_data, dict):
            try:
                last_played = int(app_data.get("LastPlayed", 0) or 0)
            except Exception:
                last_played = 0

            try:
                playtime_minutes = int(app_data.get("Playtime", 0) or app_data.get("Playtime2wks", 0) or 0)
            except Exception:
                playtime_minutes = 0

            if last_played > MIN_REAL_TIMESTAMP and playtime_minutes > 0:
                first_played_at = last_played - (playtime_minutes * 60)

            if first_played_at <= MIN_REAL_TIMESTAMP:
                first_played_at = 0

            if library_added_at > MIN_REAL_TIMESTAMP and last_played >= library_added_at:
                if first_played_at == 0 or first_played_at < library_added_at:
                    first_played_at = library_added_at + 1

    own_first_play = _own_first_play_for_app(
        appid_int,
        is_lua_game,
        last_played,
        playtime_minutes,
        first_played_at,
        update_play_state,
    )

    return {
        "success": True,
        "appid": appid_int,
        "isLuaGame": is_lua_game,
        "enabled": bool(lua_info.get("enabled")),
        "libraryAddedAt": library_added_at,
        "firstPlayedAt": first_played_at,
        "lastPlayedAt": last_played,
        "playtimeMinutes": playtime_minutes,
        "playStateUpdated": bool(update_play_state and is_lua_game),
        **own_first_play,
    }

def _stplug_appids() -> List[int]:
    stplug_dir = _stplug_dir()
    if not os.path.isdir(stplug_dir):
        return []
    appids = set()
    try:
        for name in os.listdir(stplug_dir):
            match = re.match(r"^(\d+)\.lua(?:\.disabled)?$", name)
            if match:
                appids.add(int(match.group(1)))
    except Exception:
        return []
    return sorted(appids)

def _parse_appid(value: Any) -> Optional[int]:
    try:
        appid = int(value)
    except Exception:
        return None
    if appid <= 0 or appid > MAX_APPID:
        return None
    return appid

def GetLuaGameTimes(appid: Any, contentScriptQuery: str = "", **kwargs: Any) -> str:
    if not appid and "appid" in kwargs:
        appid = kwargs.get("appid")
    appid_int = _parse_appid(appid)
    if appid_int is None:
        return json.dumps({"success": False, "error": "Invalid appid"})

    return json.dumps(_lua_game_times_for_app(appid_int))

def GetLuaGameManifest(contentScriptQuery: str = "", **kwargs: Any) -> str:
    try:
        apps_cache = _localconfig_apps(_current_user_ids())
        apps = [_lua_game_times_for_app(appid, apps_cache, update_play_state=False) for appid in _stplug_appids()]
        return json.dumps({
            "success": True,
            "count": len(apps),
            "generatedAt": int(datetime.now(timezone.utc).timestamp()),
            "apps": apps,
        })
    except Exception:
        return json.dumps({
            "success": False,
            "error": "Manifest generation failed",
            "count": 0,
            "apps": [],
        })

@lru_cache(maxsize=256)
def _public_global_achievement_percentages_cached(appid: int) -> Dict[str, float]:
    url = (
        "https://api.steampowered.com/ISteamUserStats/"
        f"GetGlobalAchievementPercentagesForApp/v0002/?gameid={appid}&format=json"
    )
    with urllib.request.urlopen(url, timeout=8) as response:
        payload = response.read(2 * 1024 * 1024)
    data = json.loads(payload.decode("utf-8", errors="replace"))
    rows = data.get("achievementpercentages", {}).get("achievements", [])
    out: Dict[str, float] = {}
    if not isinstance(rows, list):
        return out

    for row in rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name", "") or "")
        if not name:
            continue
        try:
            percent = float(row.get("percent", 0) or 0)
        except Exception:
            percent = 0
        if percent > 0:
            out[name] = percent
    return out

def GetPublicGlobalAchievementPercentages(appid: Any, contentScriptQuery: str = "", **kwargs: Any) -> str:
    if not appid and "appid" in kwargs:
        appid = kwargs.get("appid")
    appid_int = _parse_appid(appid)
    if appid_int is None:
        return json.dumps({"success": False, "error": "Invalid appid", "percentages": {}})

    try:
        percentages = _public_global_achievement_percentages_cached(appid_int)
        return json.dumps({
            "success": True,
            "appid": appid_int,
            "count": len(percentages),
            "percentages": percentages,
        })
    except Exception:
        return json.dumps({
            "success": False,
            "appid": appid_int,
            "error": "Public achievement percentage request failed",
            "percentages": {},
        })
