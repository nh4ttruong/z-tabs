const ZALO_URL = "https://chat.zalo.me/";
const ZALO_MATCH = "https://chat.zalo.me/*";
const SCRIPT_ID = "ztabs-core";
const BADGE_MIN_TABS = 3;
const BADGE_COLOR = "#00875A";
const DEFAULTS = { enabled: false, autoReload: true };

const ICONS_ON = { 16: "/icons/z-16.png", 32: "/icons/z-32.png", 48: "/icons/z-48.png", 128: "/icons/z-128.png" };
const ICONS_OFF = { 16: "/icons/z-off-16.png", 32: "/icons/z-off-32.png", 48: "/icons/z-off-48.png", 128: "/icons/z-off-128.png" };

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

function zaloTabs() {
  return chrome.tabs.query({ url: ZALO_MATCH });
}

// Registered only while on, so a tab picks up the mode on its next load.
async function syncRegistration(enabled) {
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (enabled && !registered.length) {
    await chrome.scripting.registerContentScripts([
      { id: SCRIPT_ID, matches: [ZALO_MATCH], js: ["src/content/core.js"], runAt: "document_start", world: "MAIN", allFrames: false, persistAcrossSessions: true },
    ]);
  } else if (!enabled && registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  }
}

async function updateBadge() {
  const [{ enabled }, tabs] = await Promise.all([getSettings(), zaloTabs()]);
  const n = tabs.length;
  await chrome.action.setIcon({ path: enabled ? ICONS_ON : ICONS_OFF });
  await chrome.action.setBadgeText({ text: enabled && n >= BADGE_MIN_TABS ? (n > 99 ? "99+" : String(n)) : "" });
  return { enabled, tabs: n };
}

async function setEnabled(enabled) {
  const { autoReload } = await getSettings();
  await chrome.storage.local.set({ enabled });
  await syncRegistration(enabled);

  if (!autoReload) {
    // Tabs keep their old mode until reloaded; the popup offers "Reload N tabs".
    const state = await updateBadge();
    return { ...state, openedTab: false, pendingReload: state.tabs > 0 };
  }
  return applyToZaloTabs(enabled);
}

// The second tab opens only after the reload: a multi-tab tab would kick a not-yet-reloaded one.
async function applyToZaloTabs(enabled) {
  const tabs = await zaloTabs();
  await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id)));
  let openedTab = false;
  if (enabled && tabs.length === 1) {
    await chrome.tabs.create({ url: ZALO_URL, index: tabs[0].index + 1, windowId: tabs[0].windowId, active: false });
    openedTab = true;
  }
  return { ...(await updateBadge()), openedTab, pendingReload: false };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    getState: async () => ({ ...(await getSettings()), tabs: (await zaloTabs()).length }),
    setEnabled: () => setEnabled(!!msg.enabled),
    setAutoReload: async () => {
      await chrome.storage.local.set({ autoReload: !!msg.autoReload });
      return getSettings();
    },
    reloadTabs: async () => applyToZaloTabs((await getSettings()).enabled),
  };
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler().then(sendResponse, (err) => sendResponse({ error: String(err && err.message ? err.message : err) }));
  return true; // async response
});

let badgeTimer = null;
const scheduleBadge = () => {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(updateBadge, 150);
};
chrome.tabs.onCreated.addListener(scheduleBadge);
chrome.tabs.onRemoved.addListener(scheduleBadge);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === "complete") scheduleBadge();
});

async function init() {
  await syncRegistration((await getSettings()).enabled);
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
  await updateBadge();
}
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
