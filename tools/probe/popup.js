const out = document.getElementById("out");
const boxes = [...document.querySelectorAll("input[data-k]")];

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.url && tab.url.startsWith("https://chat.zalo.me/") ? tab : null;
}

async function inPage(func, args = []) {
  const tab = await activeTab();
  if (!tab) throw new Error("Mở tab https://chat.zalo.me/ trước.");
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func, args });
  return res && res.result;
}

async function refresh() {
  try {
    const state = await inPage(() =>
      window.__zprobe
        ? {
            tab: window.__zprobe.tab,
            cfg: window.__zprobe.cfg,
            important: window.__zprobe.important().map((e) => `${e.t}ms ${e.type} ${e.important}${e.code ? " code=" + e.code : ""}${e.name ? " " + e.name : ""}`),
          }
        : null
    );
    if (!state) {
      out.textContent = "Probe chưa chạy trong tab này (reload tab).";
      return;
    }
    document.getElementById("tab").textContent = "tab=" + state.tab;
    for (const b of boxes) b.checked = !!state.cfg[b.dataset.k];
    out.textContent = "cfg = " + JSON.stringify(state.cfg) + "\n\n" + (state.important.join("\n") || "(chưa có sự kiện quan trọng)");
  } catch (e) {
    out.textContent = String(e.message || e);
  }
}

document.getElementById("apply").onclick = async () => {
  const cfg = Object.fromEntries(boxes.filter((b) => !b.disabled).map((b) => [b.dataset.k, b.checked]));
  await inPage(
    (c) => {
      window.__zprobe.set(c);
      location.reload();
    },
    [cfg],
  );
  window.close();
};
document.getElementById("download").onclick = () => inPage(() => window.__zprobe.download()).catch((e) => (out.textContent = e.message));
document.getElementById("refresh").onclick = refresh;
document.getElementById("mark").onclick = () =>
  inPage((l) => window.__zprobe.mark(l), [document.getElementById("markText").value])
    .then(() => ((document.getElementById("markText").value = ""), refresh()))
    .catch((e) => (out.textContent = e.message));
refresh();
