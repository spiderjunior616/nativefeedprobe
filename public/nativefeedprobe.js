(() => {
  const TAG = "[Native Feed Bridge]";
  const MARKER = "__NativeFeedBridgeStarted_20260523_own_first_play_v1";
  const BRIDGE_LOGIC_VERSION = "own-first-play-v1";
  const STORAGE_KEY = "__NativeFeedBridgeState_v2";
  const DEBUG_STORAGE_KEY = "__NativeFeedBridgeDebug";
  const BRIDGE_RERUN_COOLDOWN_MS = 30000;
  const MAX_APPID = 0xffffffff;

  if (window[MARKER]) {
    console.log(TAG, "already running", MARKER);
    return;
  }
  window[MARKER] = true;

  const STATE = {
    req: null,
    patchedSections: false,
    loggedApps: new Set(),
    enabledApps: new Set(),
    scheduledApps: new Set(),
    bridgingApps: new Set(),
    injectedEvents: new Set(),
    metaByApp: new Map(),
    lastBridgeFinishedAtByApp: new Map(),
    modules: null,
    patchedThreadStore: false,
    patchedCommunityService: false,
    patchedActivityStoreSanitizer: false,
    patchedUserNewsService: false,
    localSocialThreadKeys: new Set(),
    luaMetaByApp: new Map(),
    luaManifestLoaded: false,
    luaManifestRequest: null,
    localUserNewsPlanByApp: new Map(),
    localUserNewsPlanRequests: new Map(),
    publicGlobalByApp: new Map(),
    publicGlobalRequests: new Map(),
    rpcMergedEvents: new Set(),
    persistent: loadPersistentState(),
  };
  STATE.localSocialThreadKeys = new Set(STATE.persistent.localSocialThreadKeys || []);

  function isDebugLoggingEnabled() {
    try {
      return window.localStorage?.getItem(DEBUG_STORAGE_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function sanitizeLogValue(key, value) {
    if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
    const keyText = String(key || "");
    if (/(steamid|accountid|session|token|secret|password|path|dir|file|userdata|localconfig)/i.test(keyText)) {
      return "[redacted]";
    }
    if (typeof value === "string" && /([A-Za-z]:\\|\\Users\\|\/Users\/)/.test(value)) {
      return "[redacted-path]";
    }
    return value;
  }

  function stringify(value) {
    const seen = new WeakSet();
    try {
      return JSON.stringify(value, (key, val) => {
        val = sanitizeLogValue(key, val);
        if (val && typeof val === "object") {
          if (seen.has(val)) return "[circular]";
          seen.add(val);
        }
        return val;
      });
    } catch (err) {
      return `[unserializable: ${err?.message || err}]`;
    }
  }

  function log(message, data) {
    if (!isDebugLoggingEnabled()) return;
    if (data === undefined) console.log(TAG, message);
    else console.log(TAG, message, stringify(data));
  }

  function warn(message, data) {
    if (data === undefined) console.warn(TAG, message);
    else console.warn(TAG, message, stringify(data));
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function normalizeAppid(value) {
    const appid = Number(value);
    return Number.isInteger(appid) && appid > 0 && appid <= MAX_APPID ? appid : 0;
  }

  function loadPersistentState() {
    try {
      const raw = window.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return { version: 1, apps: {}, localSocialThreadKeys: [], localCommentThreads: {} };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { version: 1, apps: {}, localSocialThreadKeys: [], localCommentThreads: {} };
      parsed.version = parsed.version || 1;
      parsed.apps = parsed.apps || {};
      parsed.localSocialThreadKeys = Array.isArray(parsed.localSocialThreadKeys) ? parsed.localSocialThreadKeys : [];
      parsed.localCommentThreads = parsed.localCommentThreads && typeof parsed.localCommentThreads === "object" ? parsed.localCommentThreads : {};
      return parsed;
    } catch (err) {
      warn("failed to read bridge localStorage state", { error: err?.message || String(err) });
      return { version: 1, apps: {}, localSocialThreadKeys: [], localCommentThreads: {} };
    }
  }

  function savePersistentState() {
    try {
      window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(STATE.persistent));
    } catch (err) {
      warn("failed to save bridge localStorage state", { error: err?.message || String(err) });
    }
  }

  function getAppState(appid) {
    const key = String(appid);
    STATE.persistent.apps[key] ||= {};
    return STATE.persistent.apps[key];
  }

  function captureWebpackRequire() {
    if (STATE.req) return STATE.req;
    if (window.__NativeFeedBridgeWebpackRequire) return (STATE.req = window.__NativeFeedBridgeWebpackRequire);
    if (window.__NativeFeedUnlockerWebpackRequire) return (STATE.req = window.__NativeFeedUnlockerWebpackRequire);

    for (const chunkName of ["webpackChunksteamui", "webpackChunkappmgmt_storeadmin", "webpackChunkcommunity"]) {
      const chunk = window[chunkName];
      if (!chunk || !Array.isArray(chunk) || typeof chunk.push !== "function") continue;
      try {
        chunk.push([[Math.floor(Math.random() * 1e9)], {}, (req) => {
          window.__NativeFeedBridgeWebpackRequire = req;
          window.__NativeFeedUnlockerWebpackRequire = req;
          STATE.req = req;
        }]);
        if (STATE.req) {
          log("webpack require captured", { chunkName });
          return STATE.req;
        }
      } catch (err) {
        warn("failed to capture webpack require", { chunkName, error: err?.message || String(err) });
      }
    }
    return null;
  }

  function callMaybe(obj, names) {
    for (const name of names) {
      try {
        if (typeof obj?.[name] === "function") return obj[name]();
      } catch (_) {}
    }
    return undefined;
  }

  function getMaybe(obj, names) {
    for (const name of names) {
      try {
        const value = obj?.[name];
        if (value !== undefined && typeof value !== "function") return value;
      } catch (_) {}
    }
    return undefined;
  }

  function asNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    return 0;
  }

  function firstNumber(...values) {
    for (const value of values) {
      const n = asNumber(value);
      if (n > 0) return n;
    }
    return 0;
  }

  function getOverviewAppId(overview, details) {
    return getMaybe(overview, ["appid", "unAppID", "m_unAppID"]) ||
      getMaybe(details, ["appid", "unAppID", "m_unAppID"]) ||
      callMaybe(overview, ["GetAppID", "GetAppId", "GetAppid"]);
  }

  function getAppMeta(overview, details, context = {}) {
    const appid = normalizeAppid(getOverviewAppId(overview, details));
    const appType = getMaybe(overview, ["app_type", "eAppType", "m_eAppType"]) ??
      getMaybe(details, ["app_type", "eAppType", "m_eAppType"]) ??
      callMaybe(overview, ["GetAppType", "GetType"]);
    const modOrShortcut = !!callMaybe(overview, ["BIsModOrShortcut", "IsModOrShortcut"]);
    const displayName = getMaybe(overview, ["display_name", "name", "strDisplayName", "m_strName"]) ??
      getMaybe(details, ["display_name", "name", "strDisplayName", "m_strName"]) ??
      callMaybe(overview, ["GetDisplayName", "GetName"]);

    const lastPlayedAt = firstNumber(
      getMaybe(overview, ["rt_last_time_played", "rt_last_time_locally_played", "rtLastPlayed", "last_played_time"]),
      getMaybe(details, ["rt_last_time_played", "rt_last_time_locally_played", "rtLastPlayed", "last_played_time"]),
      callMaybe(overview, ["GetLastPlayedTime", "GetLastTimePlayed"]),
    );
    const libraryAddedAt = firstNumber(
      getMaybe(overview, ["rt_purchased_time", "rt_library_added_time", "rt_added_to_library", "rtAddedToLibrary", "rt_add_time"]),
      getMaybe(details, ["rt_purchased_time", "rt_library_added_time", "rt_added_to_library", "rtAddedToLibrary", "rt_add_time"]),
      callMaybe(overview, ["GetPurchasedTime", "GetAddedToLibraryTime", "GetLibraryAddedTime"]),
    );

    return {
      appid,
      displayName,
      appType,
      modOrShortcut,
      lastPlayedAt,
      libraryAddedAt,
      hasNativeActivity: !!context.hasNativeActivity,
      hasActivityRollup: !!context.hasActivityRollup,
      hasNonSteamSection: !!context.hasNonSteamSection,
      unlockedByBridge: !!context.unlockedByBridge,
    };
  }

  function sectionArray(sections) {
    try {
      if (sections && typeof sections[Symbol.iterator] === "function") return Array.from(sections);
    } catch (_) {}
    return [];
  }

  function hasSection(sections, name) {
    try {
      return !!sections && typeof sections.has === "function" && sections.has(name);
    } catch (_) {
      return false;
    }
  }

  function getNativeModules() {
    if (STATE.modules) return STATE.modules;
    const req = captureWebpackRequire();
    if (!req) return null;
    try {
      const activityModule = req(12750);
      const newsModule = req(16053);
      const eventModule = req(91705);
      let communityServiceModule = null;
      let achievementModule = null;
      let communityModule = null;
      try { achievementModule = req(32179); } catch (_) {}
      try { communityServiceModule = req(10812); } catch (_) {}
      try { communityModule = req(3963); } catch (_) {}
      if (!communityServiceModule) {
        try { communityServiceModule = req(10812); } catch (_) {}
      }

      STATE.modules = {
        activityStore: activityModule?.yX,
        EventClass: newsModule?.Bi,
        eventTypes: eventModule?._Q,
        achievementStore: achievementModule?.p6,
        communityService: communityServiceModule?.BE,
        communityStore: communityModule?.Nb || window.communityStore,
        userNewsService: newsModule?.eW,
      };
      log("native modules loaded", {
        hasActivityStore: !!STATE.modules.activityStore,
        hasEventClass: !!STATE.modules.EventClass,
        hasEventTypes: !!STATE.modules.eventTypes,
        hasAchievementStore: !!STATE.modules.achievementStore,
        hasCommunityService: !!STATE.modules.communityService,
        hasCommunityStore: !!STATE.modules.communityStore,
        hasUserNewsService: !!STATE.modules.userNewsService,
      });
      installActivityStoreSanitizer(STATE.modules);
      installUserNewsResponseBridge(STATE.modules);
      installLocalCommunityServiceShim(STATE.modules);
      installLocalCommentThreadFallback(STATE.modules);
      return STATE.modules;
    } catch (err) {
      warn("failed loading native modules", { error: err?.message || String(err) });
      return null;
    }
  }

  function getSelfSteamId64(activityStore) {
    try {
      const steamid = activityStore?.CMInterface?.steamid || activityStore?.m_CMInterface?.steamid;
      if (typeof steamid?.ConvertTo64BitString === "function") return steamid.ConvertTo64BitString();
      if (typeof steamid === "string") return steamid;
    } catch (_) {}
    try {
      const user = window.SteamClient?.User;
      if (typeof user?.GetSteamID === "function") {
        const value = user.GetSteamID();
        if (value) return String(value);
      }
    } catch (_) {}
    return "";
  }

  function setProto(obj, field, value) {
    const setter = `set_${field}`;
    try {
      if (typeof obj?.[setter] === "function") {
        obj[setter](value);
        return true;
      }
      obj[field] = value;
      return true;
    } catch (err) {
      warn("failed setting proto field", { field, error: err?.message || String(err) });
      return false;
    }
  }

  function createUserNewsEvent(modules, { appid, eventType, eventTime, steamid, achievementNames = [] }) {
    const event = new modules.EventClass();
    setProto(event, "eventtype", eventType);
    setProto(event, "eventtime", Math.floor(eventTime));
    setProto(event, "steamid_actor", String(steamid));
    setProto(event, "steamid_target", String(steamid));
    setProto(event, "gameid", String(appid));
    setProto(event, "appids", [Number(appid)]);
    if (achievementNames.length) setProto(event, "achievement_names", achievementNames.map(String));
    return event;
  }

  function serviceRequestBody(request) {
    return requestBody(request) || request;
  }

  function serviceResponseBody(response) {
    try { return typeof response?.Body === "function" ? response.Body() : response; } catch (_) { return response; }
  }

  function readProtoFieldValue(target, names) {
    const objectValue = requestObject(target);
    for (const name of names) {
      try {
        const value = objectValue?.[name];
        if (value !== undefined && value !== null && value !== "") return value;
      } catch (_) {}
    }
    for (const name of names) {
      try {
        const value = target?.[name];
        if (value !== undefined && value !== null && value !== "" && typeof value !== "function") return value;
      } catch (_) {}
      try {
        const getter = target?.[name];
        if (typeof getter === "function") {
          const value = getter.call(target);
          if (value !== undefined && value !== null && value !== "") return value;
        }
      } catch (_) {}
      try {
        const getter = target?.[`get_${name}`];
        if (typeof getter === "function") {
          const value = getter.call(target);
          if (value !== undefined && value !== null && value !== "") return value;
        }
      } catch (_) {}
    }
    return "";
  }

  function getMutableRepeatedProtoField(target, field) {
    try {
      const direct = target?.[field];
      if (Array.isArray(direct)) return direct;
      if (typeof direct === "function") {
        const value = direct.call(target);
        if (Array.isArray(value)) return value;
      }
    } catch (_) {}
    try {
      const getter = target?.[`get_${field}`];
      if (typeof getter === "function") {
        const value = getter.call(target);
        if (Array.isArray(value)) return value;
      }
    } catch (_) {}
    return null;
  }

  function repeatedProtoValues(target, fields) {
    const out = [];
    for (const field of fields) {
      const list = getMutableRepeatedProtoField(target, field);
      if (list) {
        for (const value of Array.from(list)) out.push(value);
        continue;
      }
      try {
        const objectValue = requestObject(target);
        const value = objectValue?.[field];
        if (Array.isArray(value)) {
          for (const item of value) out.push(item);
        }
      } catch (_) {}
    }
    return out;
  }

  function pascalFieldName(field) {
    return String(field || "").split("_").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  }

  function appendRepeatedProto(target, field, value) {
    if (!target || !field) return false;
    const adders = [`add_${field}`, `add${pascalFieldName(field)}`];
    for (const adderName of adders) {
      try {
        const adder = target?.[adderName];
        if (typeof adder === "function") {
          adder.call(target, value);
          return true;
        }
      } catch (_) {}
    }

    const list = getMutableRepeatedProtoField(target, field);
    if (list && typeof list.push === "function") {
      try {
        list.push(value);
        return true;
      } catch (_) {}
    }

    const existing = repeatedProtoValues(target, [field]);
    return setProto(target, field, existing.concat([value]));
  }

  function protoFieldConfig(messageOrClass, fieldNames) {
    const names = Array.isArray(fieldNames) ? fieldNames : [fieldNames];
    try {
      const MessageClass = typeof messageOrClass === "function" ? messageOrClass : messageOrClass?.constructor;
      const fields = MessageClass?.M?.()?.fields || {};
      for (const name of names) {
        if (fields[name]) return fields[name];
      }
      const normalizedNames = new Set(names.map((name) => String(name || "").replace(/_/g, "").toLowerCase()));
      for (const [key, value] of Object.entries(fields)) {
        if (normalizedNames.has(String(key || "").replace(/_/g, "").toLowerCase())) return value;
      }
    } catch (_) {}
    return null;
  }

  function protoFieldMessageClass(messageOrClass, fieldNames) {
    const field = protoFieldConfig(messageOrClass, fieldNames);
    return field?.c || null;
  }

  function existingAchievementDisplayData(responseBodyValue, appid) {
    for (const row of repeatedProtoValues(responseBodyValue, ["achievement_display_data", "achievementDisplayData"])) {
      const rowAppId = Number(readProtoFieldValue(row, ["appid", "appId"]));
      if (rowAppId === Number(appid)) return row;
    }
    return null;
  }

  function achievementDisplayName(ach, id) {
    return String(ach?.strName || ach?.display_name || ach?.displayName || ach?.name || id || "");
  }

  function achievementDisplayDescription(ach) {
    return String(ach?.strDescription || ach?.display_description || ach?.displayDescription || ach?.desc || ach?.description || "");
  }

  function validAchievementImageValue(value) {
    const text = String(value || "").trim();
    return !!text && text !== "[object Object]" && text !== "undefined" && text !== "null";
  }

  function rawAchievementIconValues(ach, existing) {
    return [
      ach?.icon,
      ach?.icon_url,
      ach?.iconUrl,
      ach?.image_url_achieved,
      ach?.image_url,
      ach?.imageAchieved,
      ach?.strImage,
      ach?.image,
      existing?.strImage,
      existing?.icon,
    ].filter(validAchievementImageValue).map((value) => String(value).trim());
  }

  function achievementIconTokenFromValue(value, appid) {
    if (!validAchievementImageValue(value)) return "";
    let text = String(value).trim();
    text = text.split("#")[0].split("?")[0];
    const marker = `/images/apps/${Number(appid)}/`;
    const lower = text.toLowerCase();
    const idx = lower.indexOf(marker.toLowerCase());
    if (idx >= 0) return text.slice(idx + marker.length).split("/").filter(Boolean).pop() || "";
    if (/^https?:\/\//i.test(text)) {
      try {
        const path = new URL(text).pathname;
        return path.split("/").filter(Boolean).pop() || "";
      } catch (_) {}
    }
    if (text.includes("/")) return text.split("/").filter(Boolean).pop() || "";
    return text;
  }

  function achievementDisplayIconToken(ach, appid, existing) {
    for (const value of rawAchievementIconValues(ach, existing)) {
      const token = achievementIconTokenFromValue(value, appid);
      if (token) return token;
    }
    return "";
  }

  function achievementImageUrlFromToken(appid, token) {
    if (!token) return "";
    return `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/${Number(appid)}/${token}`;
  }

  function achievementImageUrl(ach, appid, existing) {
    for (const value of rawAchievementIconValues(ach, existing)) {
      const text = String(value).trim();
      if (/^https?:\/\//i.test(text) && !text.includes("[object Object]")) return text;
    }
    return achievementImageUrlFromToken(appid, achievementDisplayIconToken(ach, appid, existing));
  }

  function appendAchievementDisplayDataToResponse(responseBodyValue, appid, achievementData, appActivity = null) {
    const stats = { appended: false, reason: "", achievements: 0, withRarity: 0, withoutRarity: 0, withIcon: 0, withoutIcon: 0 };
    if (!responseBodyValue) {
      stats.reason = "no-response-body";
      return stats;
    }
    const achieved = achievementData?.achieved || [];
    if (!achievementData?.available || !achieved.length) {
      stats.reason = "no-achievement-data";
      return stats;
    }
    if (existingAchievementDisplayData(responseBodyValue, appid)) {
      stats.reason = "already-present";
      return stats;
    }

    const DisplayClass = protoFieldMessageClass(responseBodyValue, ["achievement_display_data", "achievementDisplayData"]);
    const AchievementClass = protoFieldMessageClass(DisplayClass, ["achievements"]);
    if (typeof DisplayClass !== "function" || typeof AchievementClass !== "function") {
      stats.reason = "message-class-unavailable";
      return stats;
    }

    let display = null;
    try {
      display = new DisplayClass();
    } catch (err) {
      stats.reason = `display-construct-failed:${err?.message || err}`;
      return stats;
    }

    setProto(display, "appid", Number(appid));
    const seen = new Set();
    const appMap = getAppAchievementMap(appActivity, appid);
    for (const ach of achieved) {
      const id = String(ach?.strID || ach?.id || ach?.name || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const existing = appMap?.get?.(id);
      const iconToken = achievementDisplayIconToken(ach, appid, existing);
      if (!iconToken) {
        stats.withoutIcon += 1;
        continue;
      }

      let item = null;
      try {
        item = new AchievementClass();
      } catch (err) {
        stats.reason = `achievement-construct-failed:${err?.message || err}`;
        continue;
      }

      const percent = achievementPercent(ach, achievementData.global?.[id]);
      setProto(item, "name", id);
      setProto(item, "display_name", achievementDisplayName(ach, id) || existing?.strName || id);
      setProto(item, "display_description", achievementDisplayDescription(ach) || existing?.strDescription || "");
      setProto(item, "icon", iconToken);
      stats.withIcon += 1;
      if (percent !== undefined) {
        setProto(item, "unlocked_pct", percent);
        stats.withRarity += 1;
      } else {
        stats.withoutRarity += 1;
      }
      setProto(item, "hidden", !!(ach?.bHidden || ach?.hidden));

      if (appendRepeatedProto(display, "achievements", item)) stats.achievements += 1;
    }

    if (!stats.achievements) {
      stats.reason = stats.reason || "no-valid-achievements";
      return stats;
    }

    stats.appended = appendRepeatedProto(responseBodyValue, "achievement_display_data", display);
    stats.reason = stats.appended ? "ok" : "append-failed";
    return stats;
  }

  function getKnownAppActivity(modules, appid) {
    try {
      return typeof modules?.activityStore?.GetAppActivity === "function"
        ? modules.activityStore.GetAppActivity(appid)
        : modules?.activityStore?.m_mapAppActivity?.get?.(appid);
    } catch (_) {
      return null;
    }
  }

  function primeAppActivityAchievementRarity(modules, appid, achievementData, reason) {
    const stats = {
      reason,
      appActivity: false,
      map: null,
      refresh: null,
    };
    if (!achievementData?.available || !achievementData.achieved?.length) {
      stats.reason = `${reason}:no-achievement-data`;
      return stats;
    }

    const appActivity = getKnownAppActivity(modules, appid);
    if (!appActivity) {
      stats.reason = `${reason}:no-app-activity`;
      return stats;
    }
    stats.appActivity = true;
    stats.map = updateAchievementMap(appActivity, appid, achievementData.achieved, achievementData.global || {});
    stats.refresh = refreshAchievementEventRarity(appActivity, appid, modules.eventTypes || {});

    if (Number(stats.refresh?.changed || 0) > 0 || Number(stats.refresh?.dedupedAchievements || 0) > 0) {
      log("primed existing achievement rarity before native render", {
        appid,
        reason,
        map: stats.map,
        refresh: stats.refresh,
      });
    }
    return stats;
  }

  function userNewsRequestInfo(request) {
    const body = serviceRequestBody(request);
    const objectValue = requestObject(body);
    const appid = normalizeAppid(readBodyField(body, objectValue, ["filterappid", "filter_appid", "filterAppid", "appid"]) || 0);
    const count = Number(readBodyField(body, objectValue, ["count"]) || 0);
    const starttime = Number(readBodyField(body, objectValue, ["starttime", "start_time", "startTime"]) || 0);
    const endtime = Number(readBodyField(body, objectValue, ["endtime", "end_time", "endTime"]) || 0);
    return { appid, count, starttime, endtime };
  }

  function eventTypeForMerge(event) {
    return firstNumber(event?.eEventType, event?.eventType, readProtoFieldValue(event, ["eventtype", "event_type", "eEventType"]));
  }

  function eventTimeForMerge(event) {
    return firstNumber(event?.rtEventTime, event?.eventtime, event?.rtTimestamp, event?.time, readProtoFieldValue(event, ["eventtime", "event_time", "rtEventTime"]));
  }

  function eventAchievementIdsForMerge(event) {
    const ids = new Set(eventAchievementIds(event));
    for (const value of repeatedProtoValues(event, ["achievement_names", "achievementNames"])) {
      if (value) ids.add(String(value));
    }
    const scalar = readProtoFieldValue(event, ["achievement_names", "achievementNames"]);
    if (Array.isArray(scalar)) {
      for (const value of scalar) if (value) ids.add(String(value));
    }
    return Array.from(ids);
  }

  function eventHasAppIdForMerge(event, appid) {
    const targetAppId = Number(appid);
    if (!targetAppId) return false;
    const ids = new Set(eventAppIds(event));
    for (const value of repeatedProtoValues(event, ["appids", "appIds"])) addFiniteAppId(ids, value);
    addFiniteAppId(ids, readProtoFieldValue(event, ["gameid", "game_id", "appid", "appId"]));
    return ids.has(targetAppId);
  }

  function sameAchievementIds(left, right) {
    return sameStringSet(new Set((left || []).map(String)), new Set((right || []).map(String)));
  }

  function isEquivalentUserNewsEvent(event, appid, eventType, eventTime, achievementNames = []) {
    if (!event || eventTypeForMerge(event) !== Number(eventType)) return false;
    if (!eventHasAppIdForMerge(event, appid)) return false;
    if (Math.floor(eventTimeForMerge(event)) !== Math.floor(Number(eventTime || 0))) return false;
    const expectedIds = (achievementNames || []).map(String);
    if (!expectedIds.length) return true;
    return sameAchievementIds(eventAchievementIdsForMerge(event), expectedIds);
  }

  function responseNewsEvents(responseBodyValue) {
    return repeatedProtoValues(responseBodyValue, ["news"]);
  }

  function responseHasEquivalentUserNewsEvent(responseBodyValue, appActivity, appid, eventType, eventTime, achievementNames = []) {
    for (const event of responseNewsEvents(responseBodyValue)) {
      if (isEquivalentUserNewsEvent(event, appid, eventType, eventTime, achievementNames)) return true;
    }
    if (appActivity) {
      for (const event of collectEvents(appActivity)) {
        if (isEquivalentUserNewsEvent(event, appid, eventType, eventTime, achievementNames)) return true;
      }
    }
    return false;
  }

  function localEventMergeKey(appid, eventType, eventTime, achievementNames = []) {
    return `${Number(appid)}:${Number(eventType)}:${Math.floor(Number(eventTime || 0))}:${(achievementNames || []).map(String).sort().join(",")}`;
  }

  function withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(fallback);
      }, ms);
      Promise.resolve(promise).then((value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      }, (err) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve({ ...(fallback || {}), error: err?.message || String(err) });
      });
    });
  }

  async function loadAchievementDataForResponseMerge(modules, meta) {
    const appid = meta.appid;
    const data = await withTimeout(waitForAchievementData(modules, appid), 1600, {
      timeout: true,
      responseMergeTimeout: true,
    });
    if (!data) return { available: false, reason: "Steam achievement store unavailable" };
    if (data.timeout) return { available: false, reason: "timed out waiting for native Steam achievement data", warning: true };
    if (data.error) return { available: false, reason: "native Steam achievement error", warning: true, error: data.error };

    const achieved = Object.values(data.mine?.achieved || {});
    achieved.sort((a, b) => getAchievementUnlockTime(a) - getAchievementUnlockTime(b));
    const earliestUnlockTime = achieved.reduce((min, ach) => {
      const time = getAchievementUnlockTime(ach);
      return time && (!min || time < min) ? time : min;
    }, 0);

    let global = data.global || {};
    let raritySource = "native";
    let rarityStats = countAchievementRarity(achieved, global);
    let publicGlobalCount = 0;
    let publicGlobalTimedOut = false;
    let achievementStoreRarityPatch = null;

    if (rarityStats.withoutRarity > 0) {
      const hadCachedPublicGlobal = STATE.publicGlobalByApp.has(appid);
      const publicGlobal = hadCachedPublicGlobal
        ? (STATE.publicGlobalByApp.get(appid) || {})
        : await withTimeout(getPublicGlobalAchievementPercentages(appid), 2400, { __nativeFeedTimeout: true });
      publicGlobalTimedOut = !!publicGlobal?.__nativeFeedTimeout;
      publicGlobalCount = publicGlobalTimedOut ? 0 : Object.keys(publicGlobal || {}).length;
      if (publicGlobalCount > 0) {
        achievementStoreRarityPatch = applyPublicGlobalPercentagesToAchievementStore(modules.achievementStore, appid, publicGlobal);
        global = mergeGlobalAchievementPercentages(global, publicGlobal);
        rarityStats = countAchievementRarity(achieved, global);
        raritySource = hadCachedPublicGlobal
          ? "native+cached-public-global-stats"
          : "native+public-global-stats-response";
      }
    }

    return { available: true, achieved, global, earliestUnlockTime, raritySource, rarityStats, publicGlobalCount, publicGlobalTimedOut, achievementStoreRarityPatch };
  }

  function prepareLocalSimpleTimesForResponseMerge(appid, meta, backendTimes, earliestAchievementTime = 0) {
    const appState = getAppState(appid);
    const now = Math.floor(Date.now() / 1000);
    let changed = false;
    let skippedFirstPlayedAt = 0;
    let skippedFirstPlayedReason = "";

    if (!appState.firstSeenAt) {
      appState.firstSeenAt = now;
      changed = true;
    }

    if (backendTimes && backendTimes.isLuaGame) {
      let desiredLibraryAddedAt = Math.floor(backendTimes.libraryAddedAt || 0);
      let desiredLibraryAddedSource = desiredLibraryAddedAt ? "backend-lua" : "";
      if (desiredLibraryAddedAt && earliestAchievementTime && desiredLibraryAddedAt >= earliestAchievementTime) {
        desiredLibraryAddedAt = Math.max(1, Math.floor(earliestAchievementTime) - 120);
        desiredLibraryAddedSource = "achievement-sanity-before-first-unlock";
      }

      const currentLibrarySource = String(appState.libraryAddedSource || "");
      const shouldPreferBackendLibraryTime = desiredLibraryAddedAt && (
        !appState.libraryAddedAt ||
        appState.libraryAddedAt !== desiredLibraryAddedAt ||
        !["backend-lua", "achievement-sanity-before-first-unlock"].includes(currentLibrarySource)
      );
      if (shouldPreferBackendLibraryTime) {
        appState.libraryAddedAt = desiredLibraryAddedAt;
        appState.libraryAddedSource = desiredLibraryAddedSource;
        changed = true;
      }

      const hadFirstPlayedAt = !!appState.firstPlayedAt;
      const firstPlayedCandidate = chooseFirstPlayedCandidate(backendTimes, earliestAchievementTime);
      const desiredFirstPlayedAt = firstPlayedCandidate.time;
      const desiredFirstPlayedSource = firstPlayedCandidate.source;

      const canUseFirstPlayedAt = desiredFirstPlayedAt && (
        earliestAchievementTime ||
        hadFirstPlayedAt ||
        desiredFirstPlayedSource !== "backend-lua"
      );
      if (canUseFirstPlayedAt && appState.firstPlayedAt !== desiredFirstPlayedAt) {
        appState.firstPlayedAt = desiredFirstPlayedAt;
        appState.firstPlayedSource = desiredFirstPlayedSource;
        changed = true;
      } else if (canUseFirstPlayedAt && !appState.firstPlayedSource) {
        appState.firstPlayedSource = desiredFirstPlayedSource;
        changed = true;
      } else if (desiredFirstPlayedAt && !hadFirstPlayedAt) {
        skippedFirstPlayedAt = desiredFirstPlayedAt;
        skippedFirstPlayedReason = "waiting-for-achievement-sanity";
      }
    }

    const previousLastPlayedAt = asNumber(appState.lastObservedPlayedAt);
    appState.hasObservedApp = true;
    if (meta?.lastPlayedAt && meta.lastPlayedAt !== previousLastPlayedAt) {
      appState.lastObservedPlayedAt = Math.floor(meta.lastPlayedAt);
      changed = true;
    } else if (appState.lastObservedPlayedAt === undefined) {
      appState.lastObservedPlayedAt = previousLastPlayedAt || 0;
      changed = true;
    }
    if (changed) savePersistentState();

    return {
      libraryAddedAt: asNumber(appState.libraryAddedAt),
      libraryAddedSource: String(appState.libraryAddedSource || ""),
      firstPlayedAt: asNumber(appState.firstPlayedAt),
      firstPlayedSource: String(appState.firstPlayedSource || ""),
      skippedFirstPlayedAt,
      skippedFirstPlayedReason,
    };
  }

  function chooseFirstPlayedCandidate(backendTimes, earliestAchievementTime = 0) {
    const ownFirstPlayedAt = asNumber(backendTimes?.ownFirstPlayedAt);
    const ownConfidence = String(backendTimes?.ownFirstPlayedConfidence || "");
    const ownSource = String(backendTimes?.ownFirstPlayedSource || "observed-first-play");
    let desiredFirstPlayedAt = 0;
    let desiredFirstPlayedSource = "";

    if (ownFirstPlayedAt && ownConfidence === "observed") {
      desiredFirstPlayedAt = Math.floor(ownFirstPlayedAt);
      desiredFirstPlayedSource = `own-${ownSource}`;
    } else if (backendTimes?.firstPlayedAt) {
      desiredFirstPlayedAt = Math.floor(backendTimes.firstPlayedAt || 0);
      desiredFirstPlayedSource = "backend-lua";
    }

    if (earliestAchievementTime && (!desiredFirstPlayedAt || desiredFirstPlayedAt >= earliestAchievementTime)) {
      desiredFirstPlayedAt = Math.max(1, Math.floor(earliestAchievementTime) - 60);
      desiredFirstPlayedSource = desiredFirstPlayedSource.startsWith("own-")
        ? `${desiredFirstPlayedSource}-clamped-before-first-unlock`
        : (backendTimes?.firstPlayedAt ? "backend-lua-clamped-before-first-unlock" : "achievement-inferred-before-first-unlock");
    }

    return {
      time: desiredFirstPlayedAt,
      source: desiredFirstPlayedSource,
    };
  }

  function plannedAchievementGroups(achievementData) {
    const desiredByDay = new Map();
    if (!achievementData?.available) return [];
    for (const ach of achievementData.achieved || []) {
      const id = String(ach?.strID || ach?.id || ach?.name || "");
      const unlockTime = getAchievementUnlockTime(ach);
      if (!id || !unlockTime) continue;
      const day = localDayKeyFromUnix(unlockTime);
      if (!desiredByDay.has(day)) desiredByDay.set(day, { day, time: Math.floor(unlockTime), ids: [], idSet: new Set() });
      const group = desiredByDay.get(day);
      group.time = Math.min(group.time, Math.floor(unlockTime));
      if (!group.idSet.has(id)) {
        group.idSet.add(id);
        group.ids.push(id);
      }
    }
    return Array.from(desiredByDay.values()).map((group) => ({
      day: group.day,
      time: group.time,
      ids: group.ids,
    }));
  }

  function eventTypeOrFallback(modules, name, fallback) {
    return Number(modules?.eventTypes?.[name] || fallback);
  }

  function buildLocalUserNewsPlan(modules, meta, steamid, backendTimes, achievementData) {
    const appid = Number(meta.appid);
    const simple = prepareLocalSimpleTimesForResponseMerge(appid, meta, backendTimes, achievementData?.earliestUnlockTime || 0);
    const events = [];
    const receivedNewGame = eventTypeOrFallback(modules, "ReceivedNewGame", 3);
    const playedGameFirstTime = eventTypeOrFallback(modules, "PlayedGameFirstTime", 30);
    const achievementUnlocked = eventTypeOrFallback(modules, "AchievementUnlocked", 2);

    if (simple.libraryAddedAt && receivedNewGame) {
      events.push({
        label: `library-added:${simple.libraryAddedSource || "state"}`,
        eventType: receivedNewGame,
        eventTime: simple.libraryAddedAt,
        achievementNames: [],
      });
    }
    if (simple.firstPlayedAt && playedGameFirstTime) {
      events.push({
        label: `played-first-time:${simple.firstPlayedSource || "state"}`,
        eventType: playedGameFirstTime,
        eventTime: simple.firstPlayedAt,
        achievementNames: [],
      });
    }

    const achievementGroups = plannedAchievementGroups(achievementData);
    if (achievementUnlocked) {
      for (const group of achievementGroups) {
        events.push({
          label: `achievement-unlocked-response:${group.day}`,
          eventType: achievementUnlocked,
          eventTime: group.time,
          achievementNames: group.ids,
        });
      }
    }

    return { appid, steamid, events, simple, achievementGroups };
  }

  function cachedLocalUserNewsPlan(appid) {
    const cached = STATE.localUserNewsPlanByApp.get(Number(appid));
    if (!cached) return null;
    if (Date.now() - Number(cached.preparedAt || 0) > 15000) {
      STATE.localUserNewsPlanByApp.delete(Number(appid));
      return null;
    }
    return cached;
  }

  async function prepareLocalUserNewsPlanForApp(modules, appid, meta = {}) {
    appid = normalizeAppid(appid);
    if (!appid || !modules?.EventClass || !modules?.eventTypes) {
      return { success: false, appid, reason: "native modules incomplete" };
    }

    const steamid = getSelfSteamId64(modules.activityStore || {});
    if (!steamid) return { success: false, appid, reason: "current SteamID unavailable" };

    const mergedMeta = { ...(STATE.metaByApp.get(appid) || {}), ...(meta || {}), appid };
    const backendTimes = await getLuaGameTimes(appid, { lastPlayedAt: mergedMeta.lastPlayedAt });
    if (!backendTimes?.success || !backendTimes?.isLuaGame) {
      return { success: true, appid, isLuaGame: false, reason: backendTimes?.error || "not a configured Lua game", backendTimes };
    }

    const achievementData = await loadAchievementDataForResponseMerge(modules, mergedMeta);
    const earlyRarityPrime = primeAppActivityAchievementRarity(modules, appid, achievementData, "prewarm-plan");
    const plan = buildLocalUserNewsPlan(modules, mergedMeta, steamid, backendTimes, achievementData);
    const prepared = {
      success: true,
      appid,
      isLuaGame: true,
      steamid,
      meta: mergedMeta,
      backendTimes,
      achievementData,
      earlyRarityPrime,
      plan,
      preparedAt: Date.now(),
    };
    STATE.localUserNewsPlanByApp.set(appid, prepared);
    return prepared;
  }

  function prewarmLocalUserNewsPlan(modules, appid, meta = {}) {
    appid = normalizeAppid(appid);
    if (!appid || !modules?.EventClass || !modules?.eventTypes) return null;
    const cached = cachedLocalUserNewsPlan(appid);
    if (cached) return Promise.resolve(cached);
    if (STATE.localUserNewsPlanRequests.has(appid)) return STATE.localUserNewsPlanRequests.get(appid);

    const request = prepareLocalUserNewsPlanForApp(modules, appid, meta)
      .then((prepared) => {
        if (prepared?.isLuaGame) {
          log("prewarmed local UserNews plan for app", {
            appid,
            plannedEvents: Number(prepared.plan?.events?.length || 0),
            achievementGroups: Number(prepared.plan?.achievementGroups?.length || 0),
            achievementDataReady: !!prepared.achievementData?.available,
            rarityStats: prepared.achievementData?.rarityStats || null,
            publicGlobalPercentages: Number(prepared.achievementData?.publicGlobalCount || 0),
            publicGlobalTimedOut: !!prepared.achievementData?.publicGlobalTimedOut,
            earlyRarityPrime: prepared.earlyRarityPrime || null,
          });
        }
        return prepared;
      })
      .catch((err) => {
        warn("failed prewarming local UserNews plan", { appid, error: err?.message || String(err) });
        return { success: false, appid, reason: err?.message || String(err) };
      })
      .finally(() => {
        STATE.localUserNewsPlanRequests.delete(appid);
      });
    STATE.localUserNewsPlanRequests.set(appid, request);
    return request;
  }

  async function preparedLocalUserNewsPlanForMerge(modules, appid, meta = {}) {
    appid = normalizeAppid(appid);
    const cached = cachedLocalUserNewsPlan(appid);
    if (cached) return cached;

    const pending = STATE.localUserNewsPlanRequests.get(appid);
    if (pending) {
      const prepared = await withTimeout(pending, 2600, null);
      if (prepared) return prepared;
    }

    return await withTimeout(
      prepareLocalUserNewsPlanForApp(modules, appid, meta),
      4400,
      { success: false, appid, reason: "local UserNews plan timed out during response merge" },
    );
  }

  async function mergeLocalEventsIntoUserNewsResponse(modules, response, request) {
    const body = serviceResponseBody(response);
    const info = userNewsRequestInfo(request);
    const appid = normalizeAppid(info.appid || 0);
    if (!appid || !body || !modules?.EventClass || !modules?.eventTypes) return { skipped: true, reason: "not an app-filtered UserNews response", appid };

    const meta = { ...(STATE.metaByApp.get(appid) || {}), appid };
    const prepared = await preparedLocalUserNewsPlanForMerge(modules, appid, meta);
    if (!prepared?.success || !prepared?.isLuaGame) {
      return { skipped: true, reason: prepared?.reason || "not a configured Lua game", appid };
    }

    const steamid = prepared.steamid;
    const achievementData = prepared.achievementData;
    const plan = prepared.plan;
    let appActivity = getKnownAppActivity(modules, appid);

    let appended = 0;
    let skippedDuplicates = 0;
    let skippedAlreadyMerged = 0;
    let failedAppend = 0;

    const responseRarityPrime = primeAppActivityAchievementRarity(modules, appid, achievementData, "response-merge");
    const achievementDisplayData = appendAchievementDisplayDataToResponse(body, appid, achievementData, appActivity);

    for (const planned of plan.events) {
      const eventTime = Math.floor(Number(planned.eventTime || 0));
      const achievementNames = (planned.achievementNames || []).map(String);
      if (!eventTime || !planned.eventType) continue;

      if (responseHasEquivalentUserNewsEvent(body, appActivity, appid, planned.eventType, eventTime, achievementNames)) {
        skippedDuplicates += 1;
        rememberLocalSocialThread(steamid, planned.eventType, eventTime);
        continue;
      }

      const key = localEventMergeKey(appid, planned.eventType, eventTime, achievementNames);
      if (STATE.rpcMergedEvents.has(key)) {
        skippedAlreadyMerged += 1;
        continue;
      }

      const event = createUserNewsEvent(modules, {
        appid,
        eventType: planned.eventType,
        eventTime,
        steamid,
        achievementNames,
      });
      if (appendRepeatedProto(body, "news", event)) {
        STATE.rpcMergedEvents.add(key);
        rememberLocalSocialThread(steamid, planned.eventType, eventTime);
        appended += 1;
      } else {
        failedAppend += 1;
      }
    }

    if (appended || failedAppend || plan.simple.skippedFirstPlayedAt || achievementDisplayData.appended || achievementDisplayData.reason !== "no-achievement-data") {
      log("merged local events into UserNews.GetUserNews#1 response", {
        appid,
        request: info,
        appended,
        failedAppend,
        skippedDuplicates,
        skippedAlreadyMerged,
        plannedEvents: plan.events.length,
        achievementGroups: plan.achievementGroups.length,
        achievementData: {
          available: !!achievementData?.available,
          reason: achievementData?.reason || "",
          unlocked: Number(achievementData?.achieved?.length || 0),
          earliestUnlockTime: Number(achievementData?.earliestUnlockTime || 0),
          raritySource: achievementData?.raritySource || "",
          rarityStats: achievementData?.rarityStats || null,
          publicGlobalPercentages: Number(achievementData?.publicGlobalCount || 0),
          publicGlobalTimedOut: !!achievementData?.publicGlobalTimedOut,
          achievementStoreRarityPatch: achievementData?.achievementStoreRarityPatch || null,
        },
        earlyRarityPrime: prepared.earlyRarityPrime || null,
        responseRarityPrime,
        achievementDisplayData,
        simple: plan.simple,
        preparedAgeMs: Math.max(0, Date.now() - Number(prepared.preparedAt || Date.now())),
      });
    }

    if (appended > 0) {
      window.setTimeout(() => scheduleBridgeForApp(appid, { ...meta, responseMerge: true }), 120);
    }

    return { appended, failedAppend, skippedDuplicates, skippedAlreadyMerged };
  }

  function installUserNewsResponseBridge(modules) {
    if (STATE.patchedUserNewsService) return true;
    const service = modules?.userNewsService;
    if (!service || typeof service.GetUserNews !== "function") return false;
    if (service.__NativeFeedBridgeOriginalGetUserNews) {
      STATE.patchedUserNewsService = true;
      return true;
    }

    const original = service.GetUserNews;
    try {
      Object.defineProperty(service, "__NativeFeedBridgeOriginalGetUserNews", {
        value: original,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      service.GetUserNews = async function nativeFeedBridgeGetUserNews(transport, request) {
        const response = await original.apply(this, arguments);
        try {
          await mergeLocalEventsIntoUserNewsResponse(modules, response, request);
        } catch (err) {
          warn("UserNews.GetUserNews#1 local response merge failed", { error: err?.message || String(err) });
        }
        return response;
      };
    } catch (err) {
      warn("failed patching UserNews.GetUserNews#1", { error: err?.message || String(err) });
      return false;
    }

    STATE.patchedUserNewsService = true;
    log("patched UserNews.GetUserNews#1 with local response merge");
    return true;
  }

  async function ensureAppActivity(modules, appid) {
    const store = modules.activityStore;
    if (!store) return null;

    for (let i = 0; i < 30; i += 1) {
      try {
        const existing = typeof store.GetAppActivity === "function"
          ? store.GetAppActivity(appid)
          : store.m_mapAppActivity?.get?.(appid);
        if (existing) return existing;
        if (i === 0) {
          if (typeof store.RequestRestoreActivity === "function") store.RequestRestoreActivity(appid);
          else if (typeof store.FetchLatestActivity === "function") store.FetchLatestActivity(appid, true);
        }
      } catch (err) {
        warn("ensureAppActivity attempt failed", { appid, attempt: i, error: err?.message || String(err) });
      }
      await delay(250);
    }
    return typeof store.GetAppActivity === "function" ? store.GetAppActivity(appid) : store.m_mapAppActivity?.get?.(appid);
  }

  function addFiniteAppId(target, value) {
    const id = Number(value);
    if (Number.isFinite(id) && id > 0) target.add(id);
  }

  function getMutableEventAppIdArray(event) {
    try {
      const ids = typeof event?.GetAppIds === "function" ? event.GetAppIds() : null;
      if (ids && typeof ids.length === "number") return ids;
    } catch (_) {}
    try {
      if (event?.m_rgAppIds && typeof event.m_rgAppIds.length === "number") return event.m_rgAppIds;
    } catch (_) {}
    try {
      if (Array.isArray(event?.appids)) return event.appids;
    } catch (_) {}
    return null;
  }

  function rawEventAppIds(event) {
    const ids = [];
    const push = (value) => {
      const id = Number(value);
      if (Number.isFinite(id) && id > 0) ids.push(id);
    };
    try {
      const appIdArray = getMutableEventAppIdArray(event);
      if (appIdArray) {
        for (const id of Array.from(appIdArray)) push(id);
        return ids;
      }
      if (typeof event?.appid === "number") push(event.appid);
      if (typeof event?.gameid === "string" || typeof event?.gameid === "number") push(event.gameid);
      if (typeof event?.gameid === "function") push(event.gameid());
      if (typeof event?.appids === "function") for (const id of event.appids() || []) push(id);
    } catch (_) {}
    return ids;
  }

  function eventAppIds(event) {
    const ids = new Set();
    for (const id of rawEventAppIds(event)) addFiniteAppId(ids, id);
    return Array.from(ids);
  }

  function eventAppId(event) {
    return eventAppIds(event)[0] || 0;
  }

  function eventHasAppId(event, appid) {
    return eventAppIds(event).includes(Number(appid));
  }

  function replaceEventAppIds(event, nextIds) {
    const target = getMutableEventAppIdArray(event);
    if (!target) return false;
    const cleanIds = Array.from(new Set((nextIds || [])
      .map(Number)
      .filter((id) => Number.isFinite(id) && id > 0)))
      .sort((a, b) => a - b);
    try {
      if (typeof target.replace === "function") target.replace(cleanIds);
      else if (typeof target.splice === "function") target.splice(0, target.length, ...cleanIds);
      else return false;
      return true;
    } catch (err) {
      warn("failed replacing grouped event appids", { error: err?.message || String(err) });
      return false;
    }
  }

  function shouldRepairMismatchedSimpleEvent(eventTime, expected, options = {}) {
    if (!options.repairMismatched || !expected || eventTime === expected) return false;
    return options.repairAllMismatched ||
      (options.replaceBefore && eventTime < options.replaceBefore) ||
      (options.replaceAfter && eventTime > options.replaceAfter);
  }

  function normalizeReceivedNewGameEvents(appActivity, appid, expectedTime = 0, options = {}, reason = "received-new-game-normalize") {
    const eventTypes = STATE.modules?.eventTypes;
    const eventType = eventTypes?.ReceivedNewGame;
    const targetAppId = Number(appid);
    const expected = Math.floor(Number(expectedTime || 0));
    if (!appActivity || !eventType || !targetAppId) return { changed: 0, deduped: 0, removedFromWrongTime: 0, deletedWrongTime: 0 };

    const result = { changed: 0, deduped: 0, removedFromWrongTime: 0, deletedWrongTime: 0 };
    for (const event of collectEvents(appActivity).slice()) {
      if (event?.eEventType !== eventType || !eventHasAppId(event, targetAppId)) continue;

      const eventTime = Math.floor(getEventTime(event));
      const rawIds = rawEventAppIds(event);
      let uniqueIds = Array.from(new Set(rawIds
        .map(Number)
        .filter((id) => Number.isFinite(id) && id > 0)))
        .sort((a, b) => a - b);
      const duplicateCount = Math.max(0, rawIds.length - uniqueIds.length);
      if (duplicateCount && replaceEventAppIds(event, uniqueIds)) {
        result.changed += 1;
        result.deduped += duplicateCount;
      }

      if (shouldRepairMismatchedSimpleEvent(eventTime, expected, options)) {
        uniqueIds = uniqueIds.filter((id) => id !== targetAppId);
        if (uniqueIds.length && replaceEventAppIds(event, uniqueIds)) {
          result.changed += 1;
          result.removedFromWrongTime += 1;
          log("removed appid from mismatched grouped library event", {
            reason,
            appid: targetAppId,
            eventTime,
            desiredTime: expected,
            remainingAppIds: uniqueIds,
          });
        } else if (!uniqueIds.length && typeof appActivity.DeleteLocally === "function") {
          try {
            appActivity.DeleteLocally(event);
            result.changed += 1;
            result.deletedWrongTime += 1;
            log("removed mismatched grouped library event", {
              reason,
              appid: targetAppId,
              eventTime,
              desiredTime: expected,
            });
          } catch (err) {
            warn("failed removing mismatched grouped library event", {
              reason,
              appid: targetAppId,
              eventTime,
              desiredTime: expected,
              error: err?.message || String(err),
            });
          }
        }
      }
    }

    if (result.changed) {
      try { if (typeof appActivity.SortEvents === "function") appActivity.SortEvents(); } catch (_) {}
      log("normalized grouped library events", { reason, appid: targetAppId, expectedTime: expected, ...result });
    }
    return result;
  }

  function collectEvents(appActivity) {
    const out = [];
    try {
      for (const day of appActivity?.appActivityByDay || []) {
        const events = day?.events || day?.m_rgEvents || [];
        for (const event of events) out.push(event);
      }
    } catch (_) {}
    return out;
  }

  function collectExistingAchievementIds(appActivity, appid, eventTypes) {
    const ids = new Set();
    for (const event of collectEvents(appActivity)) {
      if (event?.eEventType !== eventTypes.AchievementUnlocked) continue;
      if (!eventHasAppId(event, appid)) continue;
      for (const id of eventAchievementIds(event)) ids.add(id);
    }
    return ids;
  }

  function getEventTime(event) {
    return firstNumber(event?.rtEventTime, event?.eventtime, event?.rtTimestamp, event?.time);
  }

  function eventAchievementIds(event) {
    const ids = new Set();
    const achievements = event?.achievements || event?.m_rgAchievements || [];
    for (const ach of achievements) {
      const id = ach?.strID || ach?.id || ach?.name;
      if (id) ids.add(String(id));
    }
    return Array.from(ids);
  }

  function localDayKeyFromUnix(unixSeconds) {
    const time = Math.floor(Number(unixSeconds || 0));
    if (!time) return "unknown";
    const date = new Date(time * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function sameStringSet(left, right) {
    if (left.size !== right.size) return false;
    for (const value of left) {
      if (!right.has(value)) return false;
    }
    return true;
  }

  function collectAchievementEventsByDay(appActivity, appid, eventTypes) {
    const byDay = new Map();
    for (const event of collectEvents(appActivity)) {
      if (event?.eEventType !== eventTypes.AchievementUnlocked) continue;
      if (!eventHasAppId(event, appid)) continue;
      const eventTime = getEventTime(event);
      const day = localDayKeyFromUnix(eventTime);
      if (!byDay.has(day)) byDay.set(day, { events: [], ids: new Set(), eventTimes: [] });
      const entry = byDay.get(day);
      entry.events.push(event);
      entry.eventTimes.push(Math.floor(eventTime));
      for (const id of eventAchievementIds(event)) entry.ids.add(id);
    }
    return byDay;
  }

  function findAchievementGroupEvent(appActivity, appid, eventTypes, day, expectedIds) {
    const desired = expectedIds instanceof Set ? expectedIds : new Set((expectedIds || []).map(String));
    if (!desired.size) return null;
    for (const event of collectEvents(appActivity)) {
      if (event?.eEventType !== eventTypes.AchievementUnlocked) continue;
      if (!eventHasAppId(event, appid)) continue;
      const eventTime = getEventTime(event);
      if (localDayKeyFromUnix(eventTime) !== day) continue;
      if (sameStringSet(new Set(eventAchievementIds(event)), desired)) return event;
    }
    return null;
  }

  function hasExistingEventAt(appActivity, appid, eventType, eventTime) {
    const expected = Math.floor(Number(eventTime || 0));
    return collectEvents(appActivity).some((event) => {
      if (event?.eEventType !== eventType || !eventHasAppId(event, appid)) return false;
      return Math.floor(getEventTime(event)) === expected;
    });
  }

  function hasExistingEventType(appActivity, appid, eventType) {
    return collectEvents(appActivity).some((event) => event?.eEventType === eventType && eventHasAppId(event, appid));
  }

  function collectSimpleEvents(appActivity, appid, eventType) {
    return collectEvents(appActivity).filter((event) => event?.eEventType === eventType && eventHasAppId(event, appid));
  }

  function findSimpleEventAt(appActivity, appid, eventType, eventTime) {
    const expected = Math.floor(Number(eventTime || 0));
    return collectSimpleEvents(appActivity, appid, eventType)
      .find((event) => Math.floor(getEventTime(event)) === expected) || null;
  }

  function activitySignature(appActivity, appid) {
    return collectEvents(appActivity)
      .filter((event) => eventHasAppId(event, appid))
      .map((event) => `${event?.eEventType || 0}:${Math.floor(getEventTime(event))}:${eventAchievementIds(event).sort().join(",")}:${eventAppIds(event).sort((a, b) => a - b).join(",")}:raw${rawEventAppIds(event).length}`)
      .sort()
      .join("|");
  }

  function activitySnapshot(appActivity, appid, eventTypes) {
    const achievementEvents = [];
    const simpleEvents = [];
    for (const event of collectEvents(appActivity)) {
      if (!eventHasAppId(event, appid)) continue;
      const eventTime = Math.floor(getEventTime(event));
      const row = {
        type: event?.eEventType || 0,
        time: eventTime,
        day: localDayKeyFromUnix(eventTime),
        appids: eventAppIds(event),
        rawAppidCount: rawEventAppIds(event).length,
      };
      if (event?.eEventType === eventTypes.AchievementUnlocked) {
        achievementEvents.push({ ...row, ids: eventAchievementIds(event) });
      } else if ([eventTypes.ReceivedNewGame, eventTypes.PlayedGameFirstTime].includes(event?.eEventType)) {
        simpleEvents.push(row);
      }
    }
    return {
      totalAppEvents: achievementEvents.length + simpleEvents.length,
      simpleEvents,
      achievementEvents,
    };
  }

  async function waitForStableActivity(appActivity, appid) {
    let last = "";
    let stableSamples = 0;
    for (let i = 0; i < 14; i += 1) {
      const signature = activitySignature(appActivity, appid);
      if (signature && signature === last) {
        stableSamples += 1;
        if (stableSamples >= 2) {
          return { stable: true, attempts: i + 1, signature };
        }
      } else {
        stableSamples = 0;
        last = signature;
      }
      await delay(300);
    }
    return { stable: false, attempts: 14, signature: last };
  }

  function sanitizeKnownBadFirstPlay(appActivity, appid, reason) {
    const eventTypes = STATE.modules?.eventTypes;
    const desiredFirstPlayedAt = asNumber(getAppState(appid).firstPlayedAt);
    if (!appActivity || !eventTypes?.PlayedGameFirstTime || !desiredFirstPlayedAt) return 0;

    let removed = 0;
    for (const event of collectEvents(appActivity).slice()) {
      if (event?.eEventType !== eventTypes.PlayedGameFirstTime || !eventHasAppId(event, appid)) continue;
      const eventTime = getEventTime(event);
      if (eventTime <= desiredFirstPlayedAt + 1) continue;
      try {
        if (typeof appActivity.DeleteLocally === "function") {
          appActivity.DeleteLocally(event);
          removed += 1;
          log("removed cached stale first-play event before UI read", {
            reason,
            appid: Number(appid),
            eventTime: Math.floor(eventTime),
            desiredFirstPlayedAt: Math.floor(desiredFirstPlayedAt),
          });
        }
      } catch (err) {
        warn("failed removing cached stale first-play event before UI read", {
          reason,
          appid: Number(appid),
          eventTime: Math.floor(eventTime),
          desiredFirstPlayedAt: Math.floor(desiredFirstPlayedAt),
          error: err?.message || String(err),
        });
      }
    }
    return removed;
  }

  function installActivityStoreSanitizer(modules) {
    if (STATE.patchedActivityStoreSanitizer) return true;
    const store = modules?.activityStore;
    if (!store || typeof store.GetAppActivity !== "function") return false;
    if (store.__NativeFeedBridgeOriginalGetAppActivity) {
      STATE.patchedActivityStoreSanitizer = true;
      return true;
    }

    const originalGetAppActivity = store.GetAppActivity;
    Object.defineProperty(store, "__NativeFeedBridgeOriginalGetAppActivity", {
      value: originalGetAppActivity,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    store.GetAppActivity = function nativeFeedBridgeGetAppActivity(appid) {
      const activity = originalGetAppActivity.apply(this, arguments);
      try { sanitizeKnownBadFirstPlay(activity, Number(appid), "GetAppActivity"); }
      catch (err) { warn("activity sanitizer failed in GetAppActivity", { appid, error: err?.message || String(err) }); }
      try { normalizeReceivedNewGameEvents(activity, Number(appid), 0, {}, "GetAppActivity"); }
      catch (err) { warn("grouped library sanitizer failed in GetAppActivity", { appid, error: err?.message || String(err) }); }
      return activity;
    };

    STATE.patchedActivityStoreSanitizer = true;
    log("patched AppActivityStore.GetAppActivity with local stale-event and grouped-library sanitizer");
    return true;
  }

  function positivePercent(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  function firstPositivePercent(...values) {
    for (const value of values) {
      const n = positivePercent(value);
      if (n !== undefined) return n;
    }
    return undefined;
  }

  function globalAchievementPercent(globalPct) {
    if (!globalPct || typeof globalPct !== "object") return positivePercent(globalPct);
    return firstPositivePercent(
      globalPct.flAchieved,
      globalPct.flGlobalAchieved,
      globalPct.percentGlobalUnlocked,
      globalPct.percent_unlocked,
      globalPct.unlocked_pct,
      globalPct.percentage,
      globalPct.percent,
    );
  }

  function achievementPercent(ach, globalPct) {
    return firstPositivePercent(
      globalAchievementPercent(globalPct),
      ach?.flAchieved,
      ach?.flGlobalAchieved,
      ach?.percentGlobalUnlocked,
      ach?.percent_unlocked,
      ach?.unlocked_pct,
      ach?.percentage,
      ach?.percent,
    );
  }

  function setAchievementPercent(target, percent) {
    if (!target) return false;
    if (Number.isFinite(percent) && percent > 0) {
      const current = Number(target.flAchieved);
      if (Number.isFinite(current) && Math.abs(current - percent) < 0.0001) return false;
      target.flAchieved = percent;
      return true;
    }
    if ("flAchieved" in target) {
      try { delete target.flAchieved; } catch (_) { target.flAchieved = undefined; }
      return true;
    }
    return false;
  }

  function countAchievementRarity(achievements, global) {
    const stats = { total: 0, withRarity: 0, withoutRarity: 0 };
    for (const ach of achievements || []) {
      const id = String(ach?.strID || ach?.id || ach?.name || "");
      if (!id) continue;
      stats.total += 1;
      if (achievementPercent(ach, global?.[id]) !== undefined) stats.withRarity += 1;
      else stats.withoutRarity += 1;
    }
    return stats;
  }

  function mergeGlobalAchievementPercentages(nativeGlobal, publicGlobal) {
    const merged = { ...(nativeGlobal || {}) };
    for (const [id, percent] of Object.entries(publicGlobal || {})) {
      if (globalAchievementPercent(merged[id]) === undefined && positivePercent(percent) !== undefined) {
        merged[id] = percent;
      }
    }
    return merged;
  }

  function parsePublicGlobalPayload(payload) {
    const percentages = payload?.percentages || payload?.achievementpercentages?.achievements;
    const out = {};
    if (Array.isArray(percentages)) {
      for (const row of percentages) {
        const id = String(row?.name || row?.strID || row?.id || "");
        const percent = positivePercent(row?.percent ?? row?.flAchieved);
        if (id && percent !== undefined) out[id] = percent;
      }
    } else if (percentages && typeof percentages === "object") {
      for (const [id, value] of Object.entries(percentages)) {
        const percent = positivePercent(value);
        if (id && percent !== undefined) out[id] = percent;
      }
    }
    return out;
  }

  async function fetchPublicGlobalAchievementsDirect(appid) {
    if (typeof fetch !== "function") return {};
    appid = normalizeAppid(appid);
    if (!appid) return {};
    const url = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?gameid=${encodeURIComponent(appid)}&format=json`;
    const response = await fetch(url, { credentials: "omit", cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parsePublicGlobalPayload(await response.json());
  }

  async function getPublicGlobalAchievementPercentages(appid) {
    appid = normalizeAppid(appid);
    if (!appid) return {};
    if (STATE.publicGlobalByApp.has(appid)) return STATE.publicGlobalByApp.get(appid);
    if (STATE.publicGlobalRequests.has(appid)) return STATE.publicGlobalRequests.get(appid);

    const request = (async () => {
      let out = {};
      try {
        if (window.Millennium?.callServerMethod) {
          const responseRaw = await window.Millennium.callServerMethod(
            "nativefeedprobe",
            "GetPublicGlobalAchievementPercentages",
            { appid },
          );
          const parsed = typeof responseRaw === "string" ? JSON.parse(responseRaw || "{}") : (responseRaw || {});
          out = parsePublicGlobalPayload(parsed);
          if (!Object.keys(out).length && parsed?.error) {
            warn("public global achievement percentage backend returned no data", { appid, error: parsed.error });
          }
        }
      } catch (err) {
        warn("public global achievement percentage backend failed", { appid, error: err?.message || String(err) });
      }

      if (!Object.keys(out).length) {
        try {
          out = await fetchPublicGlobalAchievementsDirect(appid);
        } catch (err) {
          warn("public global achievement percentage direct fetch failed", { appid, error: err?.message || String(err) });
        }
      }

      STATE.publicGlobalByApp.set(appid, out);
      log("loaded public Steam global achievement percentages", { appid, count: Object.keys(out).length });
      return out;
    })();

    STATE.publicGlobalRequests.set(appid, request);
    try {
      return await request;
    } finally {
      STATE.publicGlobalRequests.delete(appid);
    }
  }

  function applyPublicGlobalPercentagesToAchievementStore(achievementStore, appid, publicGlobal) {
    const stats = { mineChanged: 0, globalChanged: 0, publicCount: Object.keys(publicGlobal || {}).length };
    if (!achievementStore || !stats.publicCount) return stats;

    try {
      const mine = typeof achievementStore.GetMyAchievements === "function"
        ? achievementStore.GetMyAchievements(appid)
        : achievementStore.m_mapMyAchievements?.get?.(appid);
      const buckets = ["achieved", "unachieved", "hidden", "hiddenAchieved", "hiddenUnachieved"];
      if (mine?.data) {
        for (const bucket of buckets) {
          const rows = mine.data[bucket];
          if (!rows || typeof rows !== "object") continue;
          for (const [id, ach] of Object.entries(rows)) {
            const percent = positivePercent(publicGlobal[id]);
            if (percent !== undefined && setAchievementPercent(ach, percent)) stats.mineChanged += 1;
          }
        }
        try {
          achievementStore.m_mapMyAchievements?.set?.(appid, { ...mine, data: { ...mine.data } });
        } catch (_) {}
      }

      const global = typeof achievementStore.GetGlobalAchievements === "function"
        ? achievementStore.GetGlobalAchievements(appid)
        : achievementStore.m_mapGlobalAchievements?.get?.(appid);
      if (global?.data && typeof global.data === "object") {
        const nextGlobal = { ...global.data };
        for (const [id, percentRaw] of Object.entries(publicGlobal)) {
          const percent = positivePercent(percentRaw);
          if (percent !== undefined && globalAchievementPercent(nextGlobal[id]) === undefined) {
            nextGlobal[id] = percent;
            stats.globalChanged += 1;
          }
        }
        if (stats.globalChanged > 0) {
          try {
            achievementStore.m_mapGlobalAchievements?.set?.(appid, { ...global, data: nextGlobal });
          } catch (_) {
            Object.assign(global.data, nextGlobal);
          }
        }
      }
    } catch (err) {
      warn("failed applying public global percentages to native AchievementStore", { appid, error: err?.message || String(err) });
    }
    return stats;
  }

  function normalizeAchievementForMap(ach, globalPct, appid, existing = null) {
    const id = String(ach?.strID || ach?.id || ach?.name || "");
    if (!id) return null;
    const icon = achievementImageUrl(ach, appid, existing) || existing?.strImage || "";
    const normalized = {
      strID: id,
      strName: ach?.strName || ach?.display_name || ach?.displayName || ach?.name || existing?.strName || id,
      strDescription: ach?.strDescription || ach?.display_description || ach?.displayDescription || ach?.desc || ach?.description || existing?.strDescription || "",
      strImage: icon,
      bHidden: !!(ach?.bHidden || ach?.hidden || existing?.bHidden),
    };
    setAchievementPercent(normalized, achievementPercent(ach, globalPct));
    return normalized;
  }

  function getAchievementUnlockTime(ach) {
    return firstNumber(ach?.rtUnlocked, ach?.unlock_time, ach?.rtCurrentUserUnlock, ach?.rt_unlocked);
  }

  async function waitForAchievementData(modules, appid) {
    const achievementStore = modules.achievementStore;
    if (!achievementStore || typeof achievementStore.GetMyAchievements !== "function") return null;

    for (let i = 0; i < 50; i += 1) {
      let mine = null;
      let global = null;
      try {
        mine = achievementStore.GetMyAchievements(appid);
        global = typeof achievementStore.GetGlobalAchievements === "function"
          ? achievementStore.GetGlobalAchievements(appid)
          : null;
      } catch (err) {
        warn("achievement store call failed", { appid, error: err?.message || String(err) });
      }

      if (mine?.error || global?.error) return { error: mine?.error || global?.error };
      if (mine?.data && (!global || global.data)) return { mine: mine.data, global: global?.data || {} };
      await delay(200);
    }
    return { timeout: true };
  }

  function updateAchievementMap(appActivity, appid, achievements, global) {
    const stats = { entries: 0, withRarity: 0, withoutRarity: 0, withIcon: 0, withoutIcon: 0 };
    try {
      if (!appActivity.m_AchievementMap) appActivity.m_AchievementMap = new Map();
      if (!appActivity.m_AchievementMap.has(appid)) appActivity.m_AchievementMap.set(appid, new Map());
      const map = appActivity.m_AchievementMap.get(appid);
      for (const ach of achievements) {
        const id = String(ach?.strID || ach?.id || ach?.name || "");
        const existing = id ? map.get(id) : null;
        const normalized = normalizeAchievementForMap(ach, global?.[id], appid, existing);
        if (!normalized) continue;
        map.set(normalized.strID, normalized);
        stats.entries += 1;
        if (positivePercent(normalized.flAchieved) !== undefined) stats.withRarity += 1;
        else stats.withoutRarity += 1;
        if (validAchievementImageValue(normalized.strImage)) stats.withIcon += 1;
        else stats.withoutIcon += 1;
      }
      return stats;
    } catch (err) {
      warn("failed updating native achievement map", { appid, error: err?.message || String(err) });
      return stats;
    }
  }

  function getAppAchievementMap(appActivity, appid) {
    return appActivity?.m_AchievementMap?.get?.(Number(appid)) ||
      appActivity?.m_AchievementMap?.get?.(String(appid)) ||
      appActivity?.m_AchievementMap?.get?.(appid) ||
      null;
  }

  function eventAchievementObjectsById(event) {
    const out = new Map();
    const achievements = event?.achievements || event?.m_rgAchievements || [];
    for (const ach of achievements) {
      const id = String(ach?.strID || ach?.id || ach?.name || "");
      if (id) out.set(id, ach);
    }
    return out;
  }

  function dedupeEventAchievementArray(event, prop) {
    const list = event?.[prop];
    if (!Array.isArray(list) || list.length < 2) return 0;
    const seen = new Set();
    const next = [];
    for (const ach of list) {
      const id = String(ach?.strID || ach?.id || ach?.name || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      next.push(ach);
    }
    if (next.length === list.length) return 0;
    const removed = list.length - next.length;
    try {
      list.splice(0, list.length, ...next);
      return removed;
    } catch (_) {
      try {
        event[prop] = next;
        return removed;
      } catch (_) {
        return 0;
      }
    }
  }

  function dedupeEventAchievements(event) {
    return dedupeEventAchievementArray(event, "achievements") +
      dedupeEventAchievementArray(event, "m_rgAchievements");
  }

  function eventAchievementRarityMatchesMap(appActivity, appid, event, expectedIds) {
    try {
      const appMap = getAppAchievementMap(appActivity, appid);
      if (!appMap) return false;
      const eventAchievements = eventAchievementObjectsById(event);
      for (const id of expectedIds || []) {
        const source = appMap.get(String(id));
        const eventAch = eventAchievements.get(String(id));
        if (!source || !eventAch) return false;

        const expected = achievementPercent(source);
        const actual = positivePercent(eventAch.flAchieved);
        if (expected !== undefined) {
          if (actual === undefined || Math.abs(actual - expected) > 0.05) return false;
        } else if ("flAchieved" in eventAch) {
          return false;
        }
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function refreshOneAchievementEventRarity(appActivity, appid, event) {
    const stats = { events: 0, achievements: 0, changed: 0, setRarity: 0, clearedMissingRarity: 0, dedupedAchievements: 0 };
    try {
      const appMap = getAppAchievementMap(appActivity, appid);
      if (!appMap || !event) return stats;
      stats.dedupedAchievements += dedupeEventAchievements(event);
      const achievements = event?.achievements || event?.m_rgAchievements || [];
      if (!achievements.length) return stats;
      stats.events = 1;
      for (const ach of achievements) {
        const id = String(ach?.strID || ach?.id || ach?.name || "");
        if (!id) continue;
        const source = appMap.get(id);
        if (!source) continue;
        const percent = achievementPercent(source);
        const changed = setAchievementPercent(ach, percent);
        stats.achievements += 1;
        if (!changed) continue;
        stats.changed += 1;
        if (positivePercent(percent) !== undefined) stats.setRarity += 1;
        else stats.clearedMissingRarity += 1;
      }
    } catch (err) {
      warn("failed refreshing achievement rarity on one native event", { appid, error: err?.message || String(err) });
    }
    return stats;
  }

  function refreshAchievementEventRarity(appActivity, appid, eventTypes) {
    const stats = { events: 0, achievements: 0, changed: 0, setRarity: 0, clearedMissingRarity: 0, dedupedAchievements: 0 };
    try {
      for (const event of collectEvents(appActivity)) {
        if (event?.eEventType !== eventTypes.AchievementUnlocked || !eventHasAppId(event, appid)) continue;
        const one = refreshOneAchievementEventRarity(appActivity, appid, event);
        stats.events += one.events;
        stats.achievements += one.achievements;
        stats.changed += one.changed;
        stats.setRarity += one.setRarity;
        stats.clearedMissingRarity += one.clearedMissingRarity;
        stats.dedupedAchievements += one.dedupedAchievements;
      }
    } catch (err) {
      warn("failed refreshing achievement rarity on existing native events", { appid, error: err?.message || String(err) });
    }
    return stats;
  }

  async function getLuaGameTimes(appid, options = {}) {
    appid = normalizeAppid(appid);
    if (!appid) return { success: false, isLuaGame: false, error: "invalid appid" };
    const cached = STATE.luaMetaByApp.get(appid);
    const observedLastPlayedAt = asNumber(options.lastPlayedAt);
    const shouldRefreshForLastPlayed = !!(
      cached?.isLuaGame &&
      observedLastPlayedAt &&
      asNumber(cached.lastPlayedAt) !== observedLastPlayedAt
    );
    const shouldRefreshForPlayState = !!(
      cached?.isLuaGame &&
      !cached.playStateUpdated &&
      options.updatePlayState !== false
    );
    if (cached && !options.force && !shouldRefreshForLastPlayed && !shouldRefreshForPlayState) return cached;
    if (STATE.luaManifestLoaded && !cached) {
      const result = { success: true, isLuaGame: false, libraryAddedAt: 0, firstPlayedAt: 0, lastPlayedAt: 0, playtimeMinutes: 0, error: "" };
      STATE.luaMetaByApp.set(appid, result);
      return result;
    }

    let result = { success: false, isLuaGame: false, error: "Millennium backend unavailable" };
    try {
      if (window.Millennium?.callServerMethod) {
        const responseRaw = await window.Millennium.callServerMethod("nativefeedprobe", "GetLuaGameTimes", { appid });
        const parsed = typeof responseRaw === "string" ? JSON.parse(responseRaw || "{}") : (responseRaw || {});
        result = normalizeLuaGameTimes(parsed);
      }
    } catch (err) {
      result = { success: false, isLuaGame: false, error: err?.message || String(err) };
    }

    STATE.luaMetaByApp.set(appid, result);
    return result;
  }

  function normalizeLuaGameTimes(parsed) {
    parsed ||= {};
    return {
      success: !!parsed.success,
      appid: asNumber(parsed.appid),
      isLuaGame: !!parsed.isLuaGame,
      enabled: parsed.enabled !== undefined ? !!parsed.enabled : undefined,
      libraryAddedAt: asNumber(parsed.libraryAddedAt),
      firstPlayedAt: asNumber(parsed.firstPlayedAt),
      lastPlayedAt: asNumber(parsed.lastPlayedAt),
      playtimeMinutes: asNumber(parsed.playtimeMinutes),
      playStateUpdated: !!parsed.playStateUpdated,
      ownFirstPlayedAt: asNumber(parsed.ownFirstPlayedAt),
      ownFirstPlayedSource: String(parsed.ownFirstPlayedSource || ""),
      ownFirstPlayedConfidence: String(parsed.ownFirstPlayedConfidence || ""),
      ownFirstPlayedCapturedAt: asNumber(parsed.ownFirstPlayedCapturedAt),
      error: parsed.error || "",
    };
  }

  async function loadLuaGameManifest() {
    if (STATE.luaManifestLoaded) {
      return { success: true, count: STATE.luaMetaByApp.size, cached: true };
    }
    if (STATE.luaManifestRequest) return STATE.luaManifestRequest;

    STATE.luaManifestRequest = (async () => {
      let out = { success: false, count: 0, apps: [], error: "Millennium backend unavailable" };
      try {
        if (window.Millennium?.callServerMethod) {
          const responseRaw = await window.Millennium.callServerMethod("nativefeedprobe", "GetLuaGameManifest", {});
          const parsed = typeof responseRaw === "string" ? JSON.parse(responseRaw || "{}") : (responseRaw || {});
          const apps = Array.isArray(parsed.apps) ? parsed.apps : [];
          let cached = 0;
          for (const row of apps) {
            const normalized = normalizeLuaGameTimes(row);
            const rowAppid = normalizeAppid(normalized.appid || row?.appid || 0);
            if (!rowAppid) continue;
            normalized.appid = rowAppid;
            STATE.luaMetaByApp.set(rowAppid, normalized);
            cached += 1;
          }
          STATE.luaManifestLoaded = !!parsed.success;
          out = { success: !!parsed.success, count: cached, apps, generatedAt: parsed.generatedAt || 0, error: parsed.error || "" };
        }
      } catch (err) {
        out = { success: false, count: 0, apps: [], error: err?.message || String(err) };
      }

      if (out.success) log("loaded local jogos Lua manifest", { count: out.count, generatedAt: out.generatedAt || 0 });
      else warn("failed loading local jogos Lua manifest", { error: out.error || "" });
      return out;
    })();

    try {
      return await STATE.luaManifestRequest;
    } finally {
      STATE.luaManifestRequest = null;
    }
  }


  function steam64ToAccountId(steamid64) {
    try {
      if (typeof BigInt === "function") return String(BigInt(String(steamid64)) & 0xffffffffn);
    } catch (_) {}
    const n = Number(steamid64);
    return Number.isFinite(n) ? String(n >>> 0) : "0";
  }

  function localThreadKey(steamid64, gidFeature, gidFeature2) {
    return `${String(steamid64)}|${String(gidFeature)}|${String(gidFeature2 || "")}`;
  }

  function localCommentThreadId(key) {
    let hash = 2166136261;
    const input = String(key || "");
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return String(0x100000000 + (hash >>> 0));
  }

  function getLocalThreadRecord(key) {
    STATE.persistent.localCommentThreads ||= {};
    const record = STATE.persistent.localCommentThreads[key] ||= {
      comments: [],
      upvotes: 0,
      userUpvoted: false,
      nextCommentId: 1,
    };
    record.comments = Array.isArray(record.comments) ? record.comments : [];
    record.upvotes = Number(record.upvotes || 0);
    record.userUpvoted = !!record.userUpvoted;
    record.nextCommentId = Number(record.nextCommentId || 1);
    return record;
  }

  function getLocalCommentRawText(comment) {
    return String(comment?.raw_text ?? comment?.rawText ?? comment?.text ?? "");
  }

  function localCommentTextForSteam(comment) {
    const raw = getLocalCommentRawText(comment);
    if (!raw) return "";
    return raw.replace(/(^|[^A-Za-z0-9_\-\u02D0]):([A-Za-z0-9_\-]+):/g, (match, prefix, name) => {
      return `${prefix}[emoticon]${name}[/emoticon]`;
    });
  }

  function commentThreadEventTypes() {
    return [2, 3, 30];
  }

  function isLocalBridgeThreadKey(steamid64, threadType, gidFeature, gidFeature2) {
    if (Number(threadType) !== 16) return false;
    if (!commentThreadEventTypes().includes(Number(gidFeature2))) return false;
    if (!steamid64 || !gidFeature) return false;
    const current = getSelfSteamId64(STATE.modules?.activityStore || {});
    if (current && String(current) !== String(steamid64)) return false;
    return STATE.localSocialThreadKeys.has(localThreadKey(steamid64, gidFeature, gidFeature2));
  }

  function requestBody(request) {
    try { return typeof request?.Body === "function" ? request.Body() : null; } catch (_) { return null; }
  }

  function requestObject(body) {
    try {
      if (typeof body?.toObject === "function") return body.toObject();
    } catch (_) {}
    return {};
  }

  function readBodyField(body, objectValue, names) {
    for (const name of names) {
      try {
        const value = objectValue?.[name];
        if (value !== undefined && value !== null && value !== "") return value;
      } catch (_) {}
    }
    for (const name of names) {
      try {
        const getter = body?.[name];
        if (typeof getter === "function") {
          const value = getter.call(body);
          if (value !== undefined && value !== null && value !== "") return value;
        }
      } catch (_) {}
      try {
        const getter = body?.[`get_${name}`];
        if (typeof getter === "function") {
          const value = getter.call(body);
          if (value !== undefined && value !== null && value !== "") return value;
        }
      } catch (_) {}
    }
    return "";
  }

  function normalizeCommentThreadType(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      if (/^\d+$/.test(value)) return Number(value);
      if (value === "UserReceivedNewGame") return 16;
    }
    return 0;
  }

  function localThreadRequestInfo(request) {
    const body = requestBody(request);
    const objectValue = requestObject(body);
    const steamid64 = String(readBodyField(body, objectValue, ["steamid", "steamID", "steamid_actor"]) || "");
    const threadType = normalizeCommentThreadType(readBodyField(body, objectValue, ["comment_thread_type", "commentthreadtype", "commentThreadType"]));
    const gidFeature = String(readBodyField(body, objectValue, ["gidfeature", "gidFeature"]) || "");
    const gidFeature2 = String(readBodyField(body, objectValue, ["gidfeature2", "gidFeature2"]) || "");
    const gidComment = String(readBodyField(body, objectValue, ["gidcomment", "gidComment"]) || "");
    const start = Number(readBodyField(body, objectValue, ["start"]) || 0);
    const count = Number(readBodyField(body, objectValue, ["count"]) || 0);
    const oldestFirst = !!readBodyField(body, objectValue, ["oldest_first", "oldestFirst"]);
    const rateUp = !!readBodyField(body, objectValue, ["rate_up", "rateUp"]);
    const text = String(readBodyField(body, objectValue, ["text"]) || "");
    const key = localThreadKey(steamid64, gidFeature, gidFeature2);
    return { steamid64, threadType, gidFeature, gidFeature2, gidComment, start, count, oldestFirst, rateUp, text, key };
  }

  function makeLocalServiceResponse(body) {
    return {
      GetEResult: () => 1,
      GetErrorMessage: () => "OK",
      Body: () => body,
    };
  }

  function makeLocalCommentObject(comment, steamid64) {
    const objectValue = {
      gidcomment: String(comment.gidcomment),
      steamid: String(comment.steamid || steamid64),
      timestamp: Number(comment.timestamp || Math.floor(Date.now() / 1000)),
      text: localCommentTextForSteam(comment),
      upvotes: Number(comment.upvotes || 0),
      hidden: false,
      hidden_by_user: false,
      deleted: false,
      total_hidden: 0,
      upvoted_by_user: !!comment.upvoted_by_user,
      reactions: [],
      gidparentcomment: "0",
    };
    return { toObject: () => ({ ...objectValue }) };
  }

  function makeLocalThreadInfo(info, record, comments) {
    const accountId = steam64ToAccountId(info.steamid64);
    const objectValue = {
      steamid: String(info.steamid64),
      commentthreadid: localCommentThreadId(info.key),
      start: Number(info.start || 0),
      count: comments.length,
      total_count: record.comments.length,
      upvotes: Number(record.upvotes || 0),
      upvoters: record.userUpvoted ? [Number(accountId)] : [],
      user_subscribed: false,
      user_upvoted: !!record.userUpvoted,
      can_post: true,
      comment_thread_type: Number(info.threadType),
      gidfeature: String(info.gidFeature || ""),
      gidfeature2: String(info.gidFeature2 || ""),
    };
    const commentObjects = comments.map((comment) => makeLocalCommentObject(comment, info.steamid64));
    return {
      toObject: () => ({ ...objectValue }),
      comments: () => commentObjects.slice(),
    };
  }

  function localCommentSlice(record, info) {
    const all = record.comments.slice();
    const start = Math.max(0, Number(info.start || 0));
    const count = Math.max(0, Number(info.count || 0)) || 50;
    if (info.oldestFirst) return all.slice(start, start + count);
    const newestFirst = all.slice().reverse();
    return newestFirst.slice(start, start + count);
  }

  function makeLocalPostResponse(info, record, comment) {
    const body = {
      toObject: () => ({
        gidcomment: String(comment?.gidcomment || "0"),
        commentthreadid: localCommentThreadId(info.key),
        count: record.comments.length,
        upvotes: Number(record.upvotes || 0),
      }),
      gidcomment: () => String(comment?.gidcomment || "0"),
      commentthreadid: () => localCommentThreadId(info.key),
      count: () => record.comments.length,
      upvotes: () => Number(record.upvotes || 0),
    };
    return makeLocalServiceResponse(body);
  }

  function makeLocalRateResponse(info, record, comment) {
    const body = {
      toObject: () => ({
        gidcomment: String(comment?.gidcomment || "0"),
        commentthreadid: localCommentThreadId(info.key),
        count: record.comments.length,
        upvotes: Number(comment ? comment.upvotes : record.upvotes || 0),
        has_upvoted: !!(comment ? comment.upvoted_by_user : record.userUpvoted),
      }),
      gidcomment: () => String(comment?.gidcomment || "0"),
      commentthreadid: () => localCommentThreadId(info.key),
      count: () => record.comments.length,
      upvotes: () => Number(comment ? comment.upvotes : record.upvotes || 0),
      has_upvoted: () => !!(comment ? comment.upvoted_by_user : record.userUpvoted),
    };
    return makeLocalServiceResponse(body);
  }

  function rememberLocalSocialThread(steamid64, eventType, eventTime) {
    const numericType = Number(eventType);
    // Steam's native feed uses local social threads for app activity events.
    if (!commentThreadEventTypes().includes(numericType)) return;
    const key = localThreadKey(steamid64, Math.floor(eventTime), numericType);
    if (!STATE.localSocialThreadKeys.has(key)) {
      STATE.localSocialThreadKeys.add(key);
      STATE.persistent.localSocialThreadKeys = Array.from(STATE.localSocialThreadKeys);
      getLocalThreadRecord(key);
      savePersistentState();
    }
  }

  function isBridgeSocialThread(threadType, steamIDActor, gidFeature, gidFeature2) {
    if (Number(threadType) !== 16) return false;
    const eventType = Number(gidFeature2);
    if (!commentThreadEventTypes().includes(eventType)) return false;
    let steamid64 = "";
    try { steamid64 = steamIDActor?.ConvertTo64BitString?.() || String(steamIDActor || ""); } catch (_) {}
    const current = getSelfSteamId64(STATE.modules?.activityStore || {});
    if (current && steamid64 && current !== steamid64) return false;
    const key = localThreadKey(steamid64, gidFeature, gidFeature2);
    return STATE.localSocialThreadKeys.has(key);
  }

  function installLocalCommunityServiceShim(modules) {
    if (STATE.patchedCommunityService) return true;
    const service = modules?.communityService;
    if (!service) return false;
    const required = ["GetCommentThread", "PostCommentToThread", "RateCommentThread", "DeleteCommentFromThread"];
    if (!required.every((name) => typeof service[name] === "function")) return false;
    if (service.__NativeFeedBridgeOriginalCommunityMethods) {
      STATE.patchedCommunityService = true;
      return true;
    }

    const originals = {};
    for (const name of required) originals[name] = service[name];
    Object.defineProperty(service, "__NativeFeedBridgeOriginalCommunityMethods", {
      value: originals,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    service.GetCommentThread = async function localGetCommentThread(transport, request) {
      const info = localThreadRequestInfo(request);
      if (!isLocalBridgeThreadKey(info.steamid64, info.threadType, info.gidFeature, info.gidFeature2)) {
        return originals.GetCommentThread.apply(this, arguments);
      }
      const record = getLocalThreadRecord(info.key);
      const comments = localCommentSlice(record, info);
      log("served local Community.GetCommentThread#1", {
        threadType: info.threadType,
        gidFeature: info.gidFeature,
        gidFeature2: info.gidFeature2,
        start: info.start,
        count: info.count,
        returned: comments.length,
        total: record.comments.length,
      });
      return makeLocalServiceResponse(makeLocalThreadInfo(info, record, comments));
    };

    service.PostCommentToThread = async function localPostCommentToThread(transport, request) {
      const info = localThreadRequestInfo(request);
      if (!isLocalBridgeThreadKey(info.steamid64, info.threadType, info.gidFeature, info.gidFeature2)) {
        return originals.PostCommentToThread.apply(this, arguments);
      }
      const clean = String(info.text || "").trim();
      const record = getLocalThreadRecord(info.key);
      if (!clean) return makeLocalPostResponse(info, record, null);
      const comment = {
        gidcomment: `local-${Date.now()}-${record.nextCommentId++}`,
        steamid: info.steamid64,
        timestamp: Math.floor(Date.now() / 1000),
        raw_text: clean,
        text: clean,
        upvotes: 0,
        upvoted_by_user: false,
      };
      record.comments.push(comment);
      STATE.persistent.localSocialThreadKeys = Array.from(STATE.localSocialThreadKeys);
      savePersistentState();
      log("served local Community.PostCommentToThread#1", {
        gidFeature: info.gidFeature,
        gidFeature2: info.gidFeature2,
        comments: record.comments.length,
      });
      return makeLocalPostResponse(info, record, comment);
    };

    service.RateCommentThread = async function localRateCommentThread(transport, request) {
      const info = localThreadRequestInfo(request);
      if (!isLocalBridgeThreadKey(info.steamid64, info.threadType, info.gidFeature, info.gidFeature2)) {
        return originals.RateCommentThread.apply(this, arguments);
      }
      const record = getLocalThreadRecord(info.key);
      const wants = !!info.rateUp;
      let comment = null;
      if (info.gidComment) comment = record.comments.find((item) => String(item.gidcomment) === String(info.gidComment));
      if (comment) {
        const was = !!comment.upvoted_by_user;
        if (was !== wants) {
          comment.upvoted_by_user = wants;
          comment.upvotes = Math.max(0, Number(comment.upvotes || 0) + (wants ? 1 : -1));
        }
      } else {
        const was = !!record.userUpvoted;
        if (was !== wants) {
          record.userUpvoted = wants;
          record.upvotes = Math.max(0, Number(record.upvotes || 0) + (wants ? 1 : -1));
        }
      }
      savePersistentState();
      log("served local Community.RateCommentThread#1", {
        gidFeature: info.gidFeature,
        gidFeature2: info.gidFeature2,
        gidComment: info.gidComment || "",
        rateUp: wants,
        threadUpvotes: record.upvotes,
      });
      return makeLocalRateResponse(info, record, comment);
    };

    service.DeleteCommentFromThread = async function localDeleteCommentFromThread(transport, request) {
      const info = localThreadRequestInfo(request);
      if (!isLocalBridgeThreadKey(info.steamid64, info.threadType, info.gidFeature, info.gidFeature2)) {
        return originals.DeleteCommentFromThread.apply(this, arguments);
      }
      const record = getLocalThreadRecord(info.key);
      const before = record.comments.length;
      record.comments = record.comments.filter((item) => String(item.gidcomment) !== String(info.gidComment));
      savePersistentState();
      log("served local Community.DeleteCommentFromThread#1", {
        gidFeature: info.gidFeature,
        gidFeature2: info.gidFeature2,
        gidComment: info.gidComment,
        removed: before - record.comments.length,
      });
      return makeLocalServiceResponse({ toObject: () => ({}) });
    };

    STATE.patchedCommunityService = true;
    log("patched native Community comment service with local bridge responses");
    return true;
  }

  function hydrateLocalCommentThread(thread, threadType, steamIDActor, gidFeature, gidFeature2, reason = "fallback") {
    if (!thread || thread.__NativeFeedBridgeLocalHydrated) return false;
    let steamid64 = "";
    try { steamid64 = steamIDActor?.ConvertTo64BitString?.() || String(steamIDActor || ""); } catch (_) {}
    if (!steamid64) return false;
    const key = localThreadKey(steamid64, gidFeature, gidFeature2);
    const record = getLocalThreadRecord(key);
    const accountId = steam64ToAccountId(steamid64);

    const makeInfo = () => ({
      steamid: steamid64,
      commentthreadid: `nativefeedbridge-${key}`,
      comment_thread_type: Number(threadType),
      gidfeature: String(gidFeature || ""),
      gidfeature2: String(gidFeature2 || ""),
      start: 0,
      count: record.comments.length,
      total_count: record.comments.length,
      upvotes: Number(record.upvotes || 0),
      upvoters: record.userUpvoted ? [accountId] : [],
      user_upvoted: !!record.userUpvoted,
      user_subscribed: false,
      can_post: true,
    });

    const saveFromThread = () => {
      record.comments = (thread.m_rgComments || []).map((comment) => ({
        gidcomment: String(comment.gidcomment),
        steamid: String(comment.steamid || steamid64),
        timestamp: Number(comment.timestamp || Math.floor(Date.now() / 1000)),
        raw_text: getLocalCommentRawText(comment),
        text: getLocalCommentRawText(comment),
        upvotes: Number(comment.upvotes || 0),
        upvoted_by_user: !!comment.upvoted_by_user,
      }));
      record.upvotes = Number(thread.m_threadInfo?.upvotes || 0);
      record.userUpvoted = !!thread.m_threadInfo?.user_upvoted;
      record.nextCommentId = Number(record.nextCommentId || 1);
      STATE.persistent.localSocialThreadKeys = Array.from(STATE.localSocialThreadKeys);
      savePersistentState();
    };

    thread.m_threadInfo = makeInfo();
    thread.m_rgComments = record.comments.map((comment) => ({
      gidcomment: String(comment.gidcomment),
      steamid: String(comment.steamid || steamid64),
      timestamp: Number(comment.timestamp || Math.floor(Date.now() / 1000)),
      raw_text: getLocalCommentRawText(comment),
      text: localCommentTextForSteam(comment),
      upvotes: Number(comment.upvotes || 0),
      upvoted_by_user: !!comment.upvoted_by_user,
      hidden: false,
      deleted: false,
      reactions: [],
    }));
    thread.m_bUpdating = false;
    thread.m_msLastUpdated = Date.now();

    Object.defineProperty(thread, "__NativeFeedBridgeLocalHydrated", { value: true, enumerable: false, configurable: true });
    Object.defineProperty(thread, "__NativeFeedBridgeLocalKey", { value: key, enumerable: false, configurable: true });

    const setLocalThreadMethod = (name, value) => {
      try {
        Object.defineProperty(thread, name, {
          value,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      } catch (err) {
        try { thread[name] = value; }
        catch (assignErr) { warn("failed overriding local comment thread method", { name, error: assignErr?.message || err?.message || String(assignErr || err) }); }
      }
    };

    setLocalThreadMethod("RefreshIfNeeded", function localRefreshIfNeeded() {
      this.m_threadInfo ||= makeInfo();
      this.m_bUpdating = false;
    });
    setLocalThreadMethod("FetchPastComments", async function localFetchPastComments() {
      this.m_threadInfo ||= makeInfo();
      this.m_bUpdating = false;
      return this.m_rgComments;
    });
    setLocalThreadMethod("FetchRecentComments", async function localFetchRecentComments() {
      this.m_threadInfo ||= makeInfo();
      this.m_bUpdating = false;
      return this.m_rgComments;
    });
    setLocalThreadMethod("GetUpVoters", function localGetUpVoters() { return []; });
    setLocalThreadMethod("RateCommentOrThread", async function localRateCommentOrThread(rateUp, comment) {
      this.m_threadInfo ||= makeInfo();
      if (comment) {
        const was = !!comment.upvoted_by_user;
        const wants = !!rateUp;
        if (was !== wants) {
          comment.upvoted_by_user = wants;
          comment.upvotes = Math.max(0, Number(comment.upvotes || 0) + (wants ? 1 : -1));
        }
      } else {
        const was = !!this.m_threadInfo.user_upvoted;
        const wants = !!rateUp;
        if (was !== wants) {
          this.m_threadInfo.user_upvoted = wants;
          this.m_threadInfo.upvotes = Math.max(0, Number(this.m_threadInfo.upvotes || 0) + (wants ? 1 : -1));
          this.m_threadInfo.upvoters = wants ? [accountId] : [];
        }
      }
      saveFromThread();
      return true;
    });
    setLocalThreadMethod("PostCommentToThread", async function localPostCommentToThread(text) {
      const clean = String(text || "").trim();
      if (!clean) return false;
      this.m_threadInfo ||= makeInfo();
      const id = `local-${Date.now()}-${record.nextCommentId++}`;
      const comment = {
        gidcomment: id,
        steamid: steamid64,
        timestamp: Math.floor(Date.now() / 1000),
        raw_text: clean,
        text: localCommentTextForSteam({ raw_text: clean }),
        upvotes: 0,
        upvoted_by_user: false,
        hidden: false,
        deleted: false,
        reactions: [],
      };
      this.m_rgComments.push(comment);
      this.m_threadInfo.total_count = this.m_rgComments.length;
      this.m_threadInfo.count = this.m_rgComments.length;
      saveFromThread();
      return true;
    });
    setLocalThreadMethod("DeleteComment", async function localDeleteComment(comment) {
      const idx = this.m_rgComments.indexOf(comment);
      if (idx >= 0) this.m_rgComments.splice(idx, 1);
      this.m_threadInfo ||= makeInfo();
      this.m_threadInfo.total_count = this.m_rgComments.length;
      this.m_threadInfo.count = this.m_rgComments.length;
      saveFromThread();
      return true;
    });
    setLocalThreadMethod("BLocalUserOwnsThread", function localOwnsThread() { return true; });

    log("hydrated local social data for native comment thread", {
      threadType,
      gidFeature,
      gidFeature2,
      reason,
      comments: thread.m_rgComments.length,
      upvotes: thread.m_threadInfo.upvotes,
    });
    saveFromThread();
    return true;
  }

  function maybeHydrateLocalCommentThread(thread, threadType, steamIDActor, gidFeature, gidFeature2) {
    if (!isBridgeSocialThread(threadType, steamIDActor, gidFeature, gidFeature2)) return;
    window.setTimeout(() => {
      try {
        if (thread && !thread.m_threadInfo) hydrateLocalCommentThread(thread, threadType, steamIDActor, gidFeature, gidFeature2, "server-thread-missing");
      } catch (err) {
        warn("failed hydrating local social comment thread", { error: err?.message || String(err), gidFeature, gidFeature2 });
      }
    }, 1400);
  }

  function installLocalCommentThreadFallback(modules) {
    if (STATE.patchedThreadStore) return true;
    const threadStore = modules?.communityStore?.ThreadStore || window.communityStore?.ThreadStore;
    if (!threadStore || typeof threadStore.FindOrLoadThread !== "function") return false;
    if (threadStore.__NativeFeedBridgeOriginalFindOrLoadThread) {
      STATE.patchedThreadStore = true;
      return true;
    }
    const original = threadStore.FindOrLoadThread;
    Object.defineProperty(threadStore, "__NativeFeedBridgeOriginalFindOrLoadThread", {
      value: original,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    threadStore.FindOrLoadThread = function patchedFindOrLoadThread(threadType, steamIDActor, gidFeature, gidFeature2) {
      const thread = original.apply(this, arguments);
      maybeHydrateLocalCommentThread(thread, threadType, steamIDActor, gidFeature, gidFeature2);
      return thread;
    };
    STATE.patchedThreadStore = true;
    log("patched native comment ThreadStore with local social fallback");
    return true;
  }

  async function deleteLocalAppActivityEvent(appActivity, event, reason, details = {}) {
    if (!event || typeof appActivity?.DeleteLocally !== "function") return false;
    try {
      await appActivity.DeleteLocally(event);
      log("removed local AppActivityStore event before deterministic repair", {
        reason,
        eventType: event?.eEventType,
        eventTime: Math.floor(getEventTime(event)),
        achievements: eventAchievementIds(event),
        ...details,
      });
      return true;
    } catch (err) {
      warn("failed removing local AppActivityStore event", {
        reason,
        eventType: event?.eEventType,
        eventTime: Math.floor(getEventTime(event)),
        error: err?.message || String(err),
        ...details,
      });
      return false;
    }
  }

  async function refreshNativeActivity(appActivity, appid, reason) {
    let requestedStoreItems = false;
    let sorted = false;
    try {
      if (typeof appActivity?.RequestStoreItems === "function") {
        await appActivity.RequestStoreItems();
        requestedStoreItems = true;
      }
      if (typeof appActivity?.SortEvents === "function") {
        appActivity.SortEvents();
        sorted = true;
      }
      return { ok: true, requestedStoreItems, sorted };
    } catch (err) {
      warn("native activity refresh failed", { appid, reason, error: err?.message || String(err) });
      return { ok: false, requestedStoreItems, sorted, error: err?.message || String(err) };
    }
  }

  async function injectNativeEvent(modules, appActivity, appid, eventType, eventTime, steamid, label, achievementNames = [], options = {}) {
    if (!eventTime || !eventType || !steamid) return false;
    const key = `${appid}:${eventType}:${Math.floor(eventTime)}:${achievementNames.join(",") || label}`;
    if (!options.force && STATE.injectedEvents.has(key)) return false;

    const event = createUserNewsEvent(modules, { appid, eventType, eventTime, steamid, achievementNames });
    try {
      await appActivity.AddUserNewsEvent(event);
      rememberLocalSocialThread(steamid, eventType, eventTime);
      STATE.injectedEvents.add(key);
      log("pushed native UserNews event into Steam AppActivityStore", {
        appid,
        label,
        eventType,
        eventTime: Math.floor(eventTime),
        achievementNames,
        eventObject: typeof event.toObject === "function" ? event.toObject() : undefined,
      });
      return true;
    } catch (err) {
      warn("failed pushing native UserNews event", { appid, label, eventType, eventTime, error: err?.message || String(err) });
      return false;
    }
  }

  async function injectAchievementGroupVerified(modules, appActivity, appid, groupTime, steamid, achievementIds, options = {}) {
    const eventTypes = modules.eventTypes;
    const baseTime = Math.floor(Number(groupTime || 0));
    const day = localDayKeyFromUnix(baseTime);
    const ids = (achievementIds || []).map(String);
    const offsets = [0, 1, 2, 5, 10, 30, 60, 120];

    for (const offset of offsets) {
      const eventTime = baseTime + offset;
      if (localDayKeyFromUnix(eventTime) !== day) continue;

      const ok = await injectNativeEvent(
        modules,
        appActivity,
        appid,
        eventTypes.AchievementUnlocked,
        eventTime,
        steamid,
        offset ? `achievement-unlocked-grouped-retry+${offset}s` : "achievement-unlocked-grouped",
        ids,
        { force: true },
      );
      if (!ok) continue;

      if (!options.deferRefresh) await refreshNativeActivity(appActivity, appid, "verify-achievement-group");
      await delay(options.deferRefresh ? 40 : 250);

      const event = findAchievementGroupEvent(appActivity, appid, eventTypes, day, ids);
      if (event) {
        const rarityRefresh = refreshOneAchievementEventRarity(appActivity, appid, event);
        log("verified native achievement event remained in Steam AppActivityStore", {
          appid,
          eventTime,
          offset,
          achievementCount: ids.length,
          rarityRefresh,
        });
        return { ok: true, eventTime, offset, rarityRefresh };
      }

      warn("native achievement event did not persist after AddUserNewsEvent; trying another local timestamp", {
        appid,
        eventTime,
        offset,
        achievementCount: ids.length,
      });
    }

    return { ok: false, eventTime: baseTime, offset: null, rarityRefresh: null };
  }

  async function ensureSimpleEventAt(modules, appActivity, appid, eventType, desiredTime, steamid, label, options = {}) {
    const expected = Math.floor(Number(desiredTime || 0));
    if (!expected || !eventType) return 0;
    const isGroupedLibraryEvent = eventType === modules.eventTypes?.ReceivedNewGame;
    let visibleChanges = 0;

    if (isGroupedLibraryEvent) {
      const normalized = normalizeReceivedNewGameEvents(appActivity, appid, expected, options, label);
      visibleChanges += Number(normalized?.changed || 0);
      if (normalized.changed && !options.deferRefresh) await refreshNativeActivity(appActivity, appid, "normalize-simple-event");
    }

    const existing = collectSimpleEvents(appActivity, appid, eventType);
    const exact = existing.find((event) => Math.floor(getEventTime(event)) === expected);
    if (exact) return visibleChanges;

    let removed = 0;
    if (options.repairMismatched && !isGroupedLibraryEvent) {
      for (const event of existing.slice()) {
        const eventTime = Math.floor(getEventTime(event));
        if (eventTime === expected) continue;
        const shouldRepair = shouldRepairMismatchedSimpleEvent(eventTime, expected, options);
        if (!shouldRepair) continue;
        if (await deleteLocalAppActivityEvent(appActivity, event, options.repairReason || "simple-event-time-repair", {
          appid,
          eventType,
          eventTime,
          desiredTime: expected,
          label,
        })) {
          removed += 1;
          visibleChanges += 1;
        }
      }
    }

    if (findSimpleEventAt(appActivity, appid, eventType, expected)) return visibleChanges;

    const ok = await injectNativeEvent(modules, appActivity, appid, eventType, expected, steamid, label, [], { force: true });
    if (!ok) return visibleChanges;

    if (!options.deferRefresh) await refreshNativeActivity(appActivity, appid, "verify-simple-event");
    await delay(options.deferRefresh ? 40 : 200);

    if (findSimpleEventAt(appActivity, appid, eventType, expected)) {
      log("verified native simple event remained in Steam AppActivityStore", {
        appid,
        eventType,
        eventTime: expected,
        label,
        repairedExistingEvents: removed,
      });
      return visibleChanges + 1;
    }

    warn("native simple event did not persist after AddUserNewsEvent", {
      appid,
      eventType,
      eventTime: expected,
      label,
      repairedExistingEvents: removed,
    });
    return visibleChanges;
  }

  async function bridgeLibraryAndFirstPlay(modules, appActivity, meta, steamid, backendTimes, earliestAchievementTime = 0, options = {}) {
    const eventTypes = modules.eventTypes;
    const appid = meta.appid;
    const appState = getAppState(appid);
    const now = Math.floor(Date.now() / 1000);
    let changed = false;

    if (!appState.firstSeenAt) {
      appState.firstSeenAt = now;
      changed = true;
    }

    if (backendTimes && backendTimes.isLuaGame) {
      let desiredLibraryAddedAt = Math.floor(backendTimes.libraryAddedAt || 0);
      let desiredLibraryAddedSource = desiredLibraryAddedAt ? "backend-lua" : "";
      if (desiredLibraryAddedAt && earliestAchievementTime && desiredLibraryAddedAt >= earliestAchievementTime) {
        desiredLibraryAddedAt = Math.max(1, Math.floor(earliestAchievementTime) - 120);
        desiredLibraryAddedSource = "achievement-sanity-before-first-unlock";
      }

      const currentLibrarySource = String(appState.libraryAddedSource || "");
      const shouldPreferBackendLibraryTime = desiredLibraryAddedAt && (
        !appState.libraryAddedAt ||
        appState.libraryAddedAt !== desiredLibraryAddedAt ||
        !["backend-lua", "achievement-sanity-before-first-unlock"].includes(currentLibrarySource)
      );
      if (shouldPreferBackendLibraryTime) {
        appState.libraryAddedAt = desiredLibraryAddedAt;
        appState.libraryAddedSource = desiredLibraryAddedSource;
        changed = true;
      }

      const firstPlayedCandidate = chooseFirstPlayedCandidate(backendTimes, earliestAchievementTime);
      const desiredFirstPlayedAt = firstPlayedCandidate.time;
      const desiredFirstPlayedSource = firstPlayedCandidate.source;
      if (desiredFirstPlayedAt && appState.firstPlayedAt !== desiredFirstPlayedAt) {
        appState.firstPlayedAt = desiredFirstPlayedAt;
        appState.firstPlayedSource = desiredFirstPlayedSource;
        changed = true;
      } else if (desiredFirstPlayedAt && !appState.firstPlayedSource) {
        appState.firstPlayedSource = desiredFirstPlayedSource || "backend-lua";
        changed = true;
      }
    }

    const previousLastPlayedAt = asNumber(appState.lastObservedPlayedAt);
    const hadPriorObservation = !!appState.hasObservedApp;
    appState.hasObservedApp = true;
    if (meta.lastPlayedAt && meta.lastPlayedAt !== previousLastPlayedAt) {
      appState.lastObservedPlayedAt = Math.floor(meta.lastPlayedAt);
      changed = true;
    } else if (appState.lastObservedPlayedAt === undefined) {
      appState.lastObservedPlayedAt = previousLastPlayedAt || 0;
      changed = true;
    }
    if (changed) savePersistentState();

    let count = 0;
    if (earliestAchievementTime) {
      for (const event of collectEvents(appActivity).slice()) {
        if (event?.eEventType !== eventTypes.PlayedGameFirstTime || !eventHasAppId(event, appid)) continue;
        const eventTime = getEventTime(event);
        if (eventTime >= earliestAchievementTime) {
          await deleteLocalAppActivityEvent(appActivity, event, "first-play-after-achievement", {
            appid,
            displayName: meta.displayName,
            earliestAchievementTime: Math.floor(earliestAchievementTime),
          });
        }
      }
    }

    if (appState.libraryAddedAt) {
      count += await ensureSimpleEventAt(
        modules,
        appActivity,
        appid,
        eventTypes.ReceivedNewGame,
        appState.libraryAddedAt,
        steamid,
        `library-added:${appState.libraryAddedSource || "state"}`,
        {
          repairMismatched: true,
          replaceBefore: Math.floor(appState.libraryAddedAt) - 86400,
          repairReason: "library-added-time-repair",
          deferRefresh: !!options.deferRefresh,
        },
      );
    }

    if (appState.firstPlayedAt && !hasExistingEventAt(appActivity, appid, eventTypes.PlayedGameFirstTime, appState.firstPlayedAt) && !hasExistingEventType(appActivity, appid, eventTypes.PlayedGameFirstTime)) {
      count += await injectNativeEvent(modules, appActivity, appid, eventTypes.PlayedGameFirstTime, appState.firstPlayedAt, steamid, `played-first-time:${appState.firstPlayedSource || "state"}`) ? 1 : 0;
    }
    return count;
  }

  async function loadAchievementBridgeData(modules, meta) {
    const appid = meta.appid;
    const data = await waitForAchievementData(modules, appid);
    if (!data) {
      return { available: false, reason: "Steam achievement store unavailable" };
    }
    if (data.timeout) {
      return { available: false, reason: "timed out waiting for native Steam achievement data", warning: true };
    }
    if (data.error) {
      return { available: false, reason: "native Steam achievement error", warning: true, error: data.error };
    }

    const achieved = Object.values(data.mine?.achieved || {});
    if (!achieved.length) {
      return { available: true, achieved: [], global: data.global || {}, earliestUnlockTime: 0 };
    }
    achieved.sort((a, b) => getAchievementUnlockTime(a) - getAchievementUnlockTime(b));
    const earliestUnlockTime = achieved.reduce((min, ach) => {
      const time = getAchievementUnlockTime(ach);
      return time && (!min || time < min) ? time : min;
    }, 0);

    let global = data.global || {};
    let raritySource = "native";
    let rarityStats = countAchievementRarity(achieved, global);
    let publicGlobalCount = 0;
    let achievementStoreRarityPatch = null;

    if (rarityStats.withoutRarity > 0) {
      const publicGlobal = await getPublicGlobalAchievementPercentages(appid);
      publicGlobalCount = Object.keys(publicGlobal || {}).length;
      if (publicGlobalCount > 0) {
        achievementStoreRarityPatch = applyPublicGlobalPercentagesToAchievementStore(modules.achievementStore, appid, publicGlobal);
        const mergedGlobal = mergeGlobalAchievementPercentages(global, publicGlobal);
        const mergedStats = countAchievementRarity(achieved, mergedGlobal);
        if (mergedStats.withRarity > rarityStats.withRarity) {
          global = mergedGlobal;
          rarityStats = mergedStats;
          raritySource = data.global && Object.keys(data.global).length
            ? "native+public-global-stats"
            : "public-global-stats";
        }
      }
    }

    return { available: true, achieved, global, earliestUnlockTime, raritySource, rarityStats, publicGlobalCount, achievementStoreRarityPatch };
  }

  async function bridgeAchievements(modules, appActivity, meta, steamid, achievementData = null, options = {}) {
    const eventTypes = modules.eventTypes;
    const appid = meta.appid;
    const prepared = achievementData || await loadAchievementBridgeData(modules, meta);
    if (!prepared.available) {
      const payload = { appid, displayName: meta.displayName, reason: prepared.reason, error: prepared.error };
      if (prepared.warning) warn("achievement bridge skipped", payload);
      else log("achievement bridge skipped", payload);
      return { changed: 0, pushed: 0, pushedGroups: 0, rarityChanged: 0, skippedExisting: 0, preservedVisibleEvents: 0 };
    }

    const achieved = prepared.achieved || [];
    if (!achieved.length) {
      log("achievement bridge found no unlocked achievements in native Steam data", { appid, displayName: meta.displayName });
      return { changed: 0, pushed: 0, pushedGroups: 0, rarityChanged: 0, skippedExisting: 0, preservedVisibleEvents: 0 };
    }

    const mapStats = updateAchievementMap(appActivity, appid, achieved, prepared.global || {});
    const existingByDay = collectAchievementEventsByDay(appActivity, appid, eventTypes);
    const desiredByDay = new Map();
    let pushed = 0;
    let skippedExisting = 0;
    let skippedNoTime = 0;
    let repairedEvents = 0;
    let repairedRarityEvents = 0;
    let preservedVisibleEvents = 0;
    let verifiedRetryOffsets = [];
    let pushedGroups = 0;
    let rarityChanged = 0;

    for (const ach of achieved) {
      const id = String(ach?.strID || ach?.id || ach?.name || "");
      if (!id) continue;
      const unlockTime = getAchievementUnlockTime(ach);
      if (!unlockTime) {
        skippedNoTime += 1;
        continue;
      }
      const day = localDayKeyFromUnix(unlockTime);
      if (!desiredByDay.has(day)) desiredByDay.set(day, { day, time: Math.floor(unlockTime), ids: [], idSet: new Set() });
      const group = desiredByDay.get(day);
      group.time = Math.min(group.time, Math.floor(unlockTime));
      if (!group.idSet.has(id)) {
        group.idSet.add(id);
        group.ids.push(id);
      }
    }

    for (const group of desiredByDay.values()) {
      const existing = existingByDay.get(group.day);
      const desiredSet = new Set(group.ids);
      const structurallyCorrect = existing &&
        existing.events.length === 1 &&
        sameStringSet(existing.ids, desiredSet);

      if (structurallyCorrect) {
        const rarityRefresh = refreshOneAchievementEventRarity(appActivity, appid, existing.events[0]);
        rarityChanged += Number(rarityRefresh.changed || 0) + Number(rarityRefresh.dedupedAchievements || 0);
        if (eventAchievementRarityMatchesMap(appActivity, appid, existing.events[0], group.ids)) {
          skippedExisting += group.ids.length;
          preservedVisibleEvents += 1;
          log("repaired achievement rarity in place without deleting visible event", {
            appid,
            displayName: meta.displayName,
            day: group.day,
            eventTime: existing.eventTimes[0],
            achievementCount: group.ids.length,
            rarityRefresh,
          });
          continue;
        }

        skippedExisting += group.ids.length;
        preservedVisibleEvents += 1;
        warn("achievement group is visible but rarity is still not ready; preserving event and will retry later", {
          appid,
          displayName: meta.displayName,
          day: group.day,
          eventTime: existing.eventTimes[0],
          achievementCount: group.ids.length,
          rarityRefresh,
        });
        continue;
      }

      if (existing?.events?.length) {
        const missingIds = group.ids.filter((id) => !existing.ids.has(String(id)));
        if (!missingIds.length) {
          skippedExisting += group.ids.length;
          preservedVisibleEvents += existing.events.length;
          warn("achievement day has non-canonical grouping; preserving visible native events instead of deleting", {
            appid,
            displayName: meta.displayName,
            day: group.day,
            existingEvents: existing.events.length,
            existingIds: Array.from(existing.ids),
            desiredIds: group.ids,
          });
          continue;
        }

        warn("achievement day is missing unlocked achievements; adding missing local event without deleting visible rows", {
          appid,
          displayName: meta.displayName,
          day: group.day,
          existingEvents: existing.events.length,
          missingIds,
        });
        const result = await injectAchievementGroupVerified(modules, appActivity, appid, group.time, steamid, missingIds, {
          deferRefresh: !!options.deferRefresh,
        });
        if (result.ok) {
          pushed += missingIds.length;
          pushedGroups += 1;
          if (result.offset) verifiedRetryOffsets.push(result.offset);
        }
        continue;
      }

      const result = await injectAchievementGroupVerified(modules, appActivity, appid, group.time, steamid, group.ids, {
        deferRefresh: !!options.deferRefresh,
      });
      if (result.ok) {
        pushed += group.ids.length;
        pushedGroups += 1;
        if (result.offset) verifiedRetryOffsets.push(result.offset);
      }
    }

    const rarityRefresh = refreshAchievementEventRarity(appActivity, appid, eventTypes);
    rarityChanged += Number(rarityRefresh.changed || 0) + Number(rarityRefresh.dedupedAchievements || 0);

    log("achievement bridge completed using native Steam achievement data", {
      appid,
      displayName: meta.displayName,
      unlockedInSteamData: achieved.length,
      achievementMapEntries: mapStats.entries,
      achievementMapWithRarity: mapStats.withRarity,
      achievementMapWithoutRarity: mapStats.withoutRarity,
      raritySource: prepared.raritySource || "native",
      rarityStats: prepared.rarityStats || null,
      publicGlobalPercentages: prepared.publicGlobalCount || 0,
      achievementStoreRarityPatch: prepared.achievementStoreRarityPatch || null,
      refreshedAchievementRarity: rarityRefresh,
      desiredGroups: desiredByDay.size,
      pushedAchievements: pushed,
      pushedGroups,
      rarityChanged,
      repairedEvents,
      repairedRarityEvents,
      preservedVisibleEvents,
      verifiedRetryOffsets,
      skippedExisting,
      skippedNoTime,
    });
    return {
      changed: pushed + (rarityChanged > 0 ? 1 : 0),
      pushed,
      pushedGroups,
      rarityChanged,
      skippedExisting,
      preservedVisibleEvents,
      skippedNoTime,
    };
  }

  async function runBridgeForApp(appid) {
    appid = normalizeAppid(appid);
    if (!appid || STATE.bridgingApps.has(appid)) return;
    STATE.bridgingApps.add(appid);

    try {
      const modules = getNativeModules();
      installLocalCommentThreadFallback(modules);
      if (!modules?.activityStore || !modules?.EventClass || !modules?.eventTypes) {
        warn("bridge skipped; native modules incomplete", { appid, modules: modules ? Object.keys(modules) : null });
        return;
      }

      const meta = STATE.metaByApp.get(appid) || { appid };
      const steamid = getSelfSteamId64(modules.activityStore);
      if (!steamid) {
        warn("bridge skipped; could not resolve current SteamID", { appid, displayName: meta.displayName });
        return;
      }

      const backendTimes = await getLuaGameTimes(appid, { lastPlayedAt: meta.lastPlayedAt });
      if (!backendTimes.success) {
        warn("bridge skipped; Lua game probe failed", {
          appid,
          displayName: meta.displayName,
          error: backendTimes.error || "",
        });
        return;
      }
      if (!backendTimes.isLuaGame) {
        log("bridge skipped; app is not a configured Lua game", {
          appid,
          displayName: meta.displayName,
        });
        return;
      }

      // Ask Steam to restore/fetch first, then only fill gaps. This keeps native data authoritative.
      try {
        if (typeof modules.activityStore.FetchLatestActivity === "function") modules.activityStore.FetchLatestActivity(appid, true);
        else if (typeof modules.activityStore.RequestRestoreActivity === "function") modules.activityStore.RequestRestoreActivity(appid);
      } catch (_) {}

      const appActivity = await ensureAppActivity(modules, appid);
      if (!appActivity) {
        warn("bridge skipped; AppActivity object not available", { appid, displayName: meta.displayName });
        return;
      }

      const stableInfo = await waitForStableActivity(appActivity, appid);
      const achievementData = await loadAchievementBridgeData(modules, meta);
      const earliestAchievementTime = achievementData?.earliestUnlockTime || 0;

      const beforeEvents = collectEvents(appActivity).length;
      const beforeSnapshot = activitySnapshot(appActivity, appid, modules.eventTypes);
      const simpleChanged = await bridgeLibraryAndFirstPlay(modules, appActivity, meta, steamid, backendTimes, earliestAchievementTime, {
        deferRefresh: true,
      });
      const achievementResult = await bridgeAchievements(modules, appActivity, meta, steamid, achievementData, {
        deferRefresh: true,
      });
      const achievementChanged = Number(achievementResult?.changed || 0);
      const totalChanged = simpleChanged + achievementChanged;

      let finalRefresh = { skipped: true, reason: "no-visible-changes" };
      if (totalChanged > 0) {
        finalRefresh = await refreshNativeActivity(appActivity, appid, "post-bridge-final");
        await delay(60);
      }

      const afterEvents = collectEvents(appActivity).length;
      const afterSnapshot = activitySnapshot(appActivity, appid, modules.eventTypes);
      log("native bridge finished for app", {
        appid,
        displayName: meta.displayName,
        logicVersion: BRIDGE_LOGIC_VERSION,
        luaGame: true,
        backendTimes,
        totalChanged,
        simpleChanged,
        achievementChanged,
        pushedAchievements: Number(achievementResult?.pushed || 0),
        preservedAchievementGroups: Number(achievementResult?.preservedVisibleEvents || 0),
        skippedAchievements: Number(achievementResult?.skippedExisting || 0),
        rarityChanged: Number(achievementResult?.rarityChanged || 0),
        finalRefresh,
        stableInfo: {
          stable: !!stableInfo?.stable,
          attempts: Number(stableInfo?.attempts || 0),
          signatureLength: String(stableInfo?.signature || "").length,
        },
        beforeEvents,
        afterEvents,
        beforeSnapshot,
        afterSnapshot,
        pushedEvents: totalChanged,
        pushedSimpleEvents: simpleChanged,
        note: "Steam native AppActivityStore + Steam native renderer; data is local bridge where server feed is missing.",
      });
    } finally {
      STATE.bridgingApps.delete(appid);
      STATE.lastBridgeFinishedAtByApp.set(appid, Date.now());
    }
  }

  function scheduleBridgeForApp(appid, meta) {
    appid = normalizeAppid(appid);
    if (!appid) return;
    STATE.metaByApp.set(appid, { ...(STATE.metaByApp.get(appid) || {}), ...(meta || {}) });
    const modules = STATE.modules || getNativeModules();
    if (modules && !meta?.responseMerge) prewarmLocalUserNewsPlan(modules, appid, meta);
    const lastFinishedAt = STATE.lastBridgeFinishedAtByApp.get(appid) || 0;
    if (lastFinishedAt && Date.now() - lastFinishedAt < BRIDGE_RERUN_COOLDOWN_MS) return;
    if (STATE.bridgingApps.has(appid)) return;
    if (STATE.scheduledApps.has(appid)) return;
    STATE.scheduledApps.add(appid);
    window.setTimeout(() => {
      STATE.scheduledApps.delete(appid);
      runBridgeForApp(appid);
    }, meta?.responseMerge ? 120 : (STATE.patchedUserNewsService ? 900 : 50));
  }

  function patchAppDetailsSections() {
    if (STATE.patchedSections) return true;
    const req = captureWebpackRequire();
    if (!req) return false;

    let sectionModule;
    try {
      sectionModule = req(59856);
    } catch (err) {
      warn("module 59856 unavailable", { error: err?.message || String(err) });
      return false;
    }

    const proto = sectionModule?.N_?.prototype;
    if (!proto || typeof proto.GetSections !== "function") {
      warn("AppDetails GetSections prototype not found", { moduleKeys: Object.keys(sectionModule || {}) });
      return false;
    }

    if (proto.__NativeFeedBridgeOriginalGetSections) {
      STATE.patchedSections = true;
      log("GetSections already patched by this bridge/previous run");
      return true;
    }

    const original = proto.GetSections;
    Object.defineProperty(proto, "__NativeFeedBridgeOriginalGetSections", {
      value: original,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    proto.GetSections = function patchedGetSections(overview, details) {
      const sections = original.call(this, overview, details);
      const appid = normalizeAppid(getOverviewAppId(overview, details));
      const key = String(appid || "unknown");
      const before = sectionArray(sections);

      const hadActivity = before.includes("activity") || hasSection(sections, "activity");
      const hadActivityRollup = before.includes("activityrollup") || hasSection(sections, "activityrollup");
      const hasNonSteam = before.includes("nonsteam") || hasSection(sections, "nonsteam");
      const shouldUnlock = !!appid && (!hadActivity || !hadActivityRollup);
      const meta = getAppMeta(overview, details, {
        hasNativeActivity: hadActivity,
        hasActivityRollup: hadActivityRollup,
        hasNonSteamSection: hasNonSteam,
        unlockedByBridge: shouldUnlock,
      });

      if (!STATE.loggedApps.has(key)) {
        STATE.loggedApps.add(key);
        log("observed app sections", {
          ...meta,
          sectionCount: before.length,
          sections: before,
        });
      }

      if (shouldUnlock && sections && typeof sections.add === "function") {
        sections.add("activity");
        sections.add("activityrollup");
        if (!STATE.enabledApps.has(key)) {
          STATE.enabledApps.add(key);
          log("enabled native Steam activity sections for app missing native activity", {
            ...meta,
            before,
            after: sectionArray(sections),
          });
        }
      }

      // The section is native; this only feeds native-shaped UserNews where Steam has no feed row.
      if (appid) scheduleBridgeForApp(appid, { ...meta, unlockedByBridge: shouldUnlock });

      return sections;
    };

    STATE.patchedSections = true;
    log("patched Steam AppDetails GetSections and enabled native AppActivityStore bridge");
    getNativeModules();
    return true;
  }

  function start() {
    log("initialized", {
      marker: MARKER,
      mode: "native-store-bridge",
      logicVersion: BRIDGE_LOGIC_VERSION,
      note: "separate plugin; Steam native AppActivityStore/renderer are used",
    });
    loadLuaGameManifest();
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (patchAppDetailsSections() || tries > 120) {
        window.clearInterval(timer);
        if (!STATE.patchedSections) warn("gave up patching GetSections after retries", { tries });
      }
    }, 250);
    patchAppDetailsSections();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
