const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const BADGE_MIN_TABS = 3;
const TOAST_MS = 2500;

let state = { enabled: false, autoReload: true, tabs: 0 };
let pendingReload = false;
let toastTimer = null;
let busy = false;

function render() {
  $("toggle").setAttribute("aria-checked", String(state.enabled));
  $("toggle").disabled = busy;
  $("auto").setAttribute("aria-pressed", String(state.autoReload));

  const badge = $("badge");
  const showBadge = state.enabled && state.tabs >= BADGE_MIN_TABS;
  badge.hidden = !showBadge;
  badge.textContent = state.tabs > 99 ? "99+" : String(state.tabs);
  badge.setAttribute("aria-label", `${state.tabs} tabs in sync`);

  const toast = toastTimer !== null;
  $("toast").hidden = !toast;
  $("pending").hidden = toast || !pendingReload;
  $("pending").textContent = `Reload ${state.tabs} tab${state.tabs === 1 ? "" : "s"}`;
  $("credit").hidden = toast || pendingReload;
}

function showToast() {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    render();
  }, TOAST_MS);
}

function apply(res) {
  if (!res || res.error) return;
  ({ enabled: state.enabled, tabs: state.tabs, pendingReload } = res);
  if (res.openedTab) showToast();
}

async function run(task) {
  busy = true;
  render();
  try {
    apply(await task());
  } finally {
    busy = false;
    render();
  }
}

$("toggle").addEventListener("click", () => {
  if (busy) return;
  state.enabled = !state.enabled; // optimistic: the switch moves immediately
  run(() => send({ type: "setEnabled", enabled: state.enabled }));
});

$("auto").addEventListener("click", async () => {
  const res = await send({ type: "setAutoReload", autoReload: !state.autoReload });
  if (res && !res.error) state.autoReload = res.autoReload;
  render();
});

$("pending").addEventListener("click", () => run(() => send({ type: "reloadTabs" })));

// A plain link click would navigate the popup itself.
$("creditLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: e.currentTarget.href });
});

// Keep the tab count live while the popup is open.
let refreshTimer = null;
const refresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const res = await send({ type: "getState" });
    if (res && !res.error) state.tabs = res.tabs;
    render();
  }, 150);
};
chrome.tabs.onCreated.addListener(refresh);
chrome.tabs.onRemoved.addListener(refresh);
chrome.tabs.onUpdated.addListener((_id, info) => info.url && refresh());

send({ type: "getState" }).then((res) => {
  if (res && !res.error) state = { enabled: res.enabled, autoReload: res.autoReload, tabs: res.tabs };
  render();
});
render();
