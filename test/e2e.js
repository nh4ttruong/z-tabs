const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const ZALO = "https://chat.zalo.me/";
const PAGE = fs.readFileSync(path.join(__dirname, "zalo-like.html"), "utf8");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const frame = (cmd, sub, obj) => Buffer.concat([Buffer.from([1, cmd & 255, cmd >> 8, sub]), Buffer.from(JSON.stringify(obj))]);

function encrypt(key, obj) {
  const iv = crypto.randomBytes(16);
  const aad = crypto.randomBytes(16);
  const c = crypto.createCipheriv("aes-128-gcm", Buffer.from(key, "base64"), iv).setAAD(aad);
  const data = Buffer.concat([iv, aad, c.update(zlib.deflateSync(JSON.stringify(obj))), c.final(), c.getAuthTag()]);
  return { encrypt: 2, data: encodeURIComponent(data.toString("base64")) };
}

// Zalo's chat server as measured: one socket per account (a new one gets the old one cmd 3000 and dropped), encrypted replies, pushes.
const server = { socket: null, kicks: 0 };
function serve(ws) {
  const old = server.socket;
  if (old) {
    server.kicks++;
    old.send(frame(3000, 0, {}));
    setTimeout(() => old.close(), 1500);
  }
  server.socket = ws;
  const key = crypto.randomBytes(16).toString("base64");
  if (!ws.url().includes("nohs")) ws.send(frame(1, 1, { key }));
  ws.onMessage((data) => {
    if (data.readUInt16LE(1) !== 510) return;
    const { reqId } = JSON.parse(data.subarray(4));
    setTimeout(() => ws.send(frame(510, 1, encrypt(key, { reqId }))), 20 + Math.random() * 50);
  });
  ws.onClose(() => server.socket === ws && (server.socket = null));
}

let ctx, sw, popup, profile, pushes;
const zaloPages = () => ctx.pages().filter((p) => p.url().startsWith(ZALO));
const stats = (p) => p.evaluate(() => ({ ...window.stats, locked: !!window.locked, role: window.__ztabs?.status().role }));
const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
const coreScripts = () => sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());

async function openZalo(query = "") {
  const p = await ctx.newPage();
  await p.goto(ZALO + query);
  return p;
}
async function closeZalo() {
  for (const p of zaloPages()) await p.close();
  await wait(300);
}
// Tabs the extension opens can load before Playwright's route attaches and hit the resolver block: load those again through the mock.
async function waitForZaloTabs(n) {
  for (let i = 0; i < 50 && zaloPages().length < n; i++) {
    for (const p of ctx.pages()) if (p.url().startsWith("chrome-error:")) await p.goto(ZALO);
    await wait(100);
  }
  assert.strictEqual(zaloPages().length, n);
}
async function toggle() {
  await popup.bringToFront();
  await popup.click("#toggle");
}
// Every Zalo tab must keep getting pushes and its own replies over `ms`.
async function assertLive(ms) {
  const start = await Promise.all(zaloPages().map(stats));
  await wait(ms);
  const end = await Promise.all(zaloPages().map(stats));
  end.forEach((s, i) => assert.ok(s.pushes > start[i].pushes && s.myResp > start[i].myResp, `tab ${i} stopped receiving`));
  return end;
}

before(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "ztabs-e2e-"));
  ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, "--host-resolver-rules=MAP *zalo.me ~NOTFOUND"],
  });
  await ctx.route(/^https:\/\/chat\.zalo\.me\//, (r) => r.fulfill({ contentType: "text/html", body: PAGE }));
  await ctx.routeWebSocket(/-msg\.chat\.zalo\.me/, serve);
  pushes = setInterval(() => server.socket?.send(frame(501, 0, {})), 500);
  sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
  popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${new URL(sw.url()).host}/src/popup/popup.html`);
});

after(async () => {
  clearInterval(pushes);
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
});

test("off: plain Zalo Web, a second tab locks the first", async () => {
  assert.deepStrictEqual(await coreScripts(), []);
  const first = await openZalo();
  await wait(700);
  await openZalo();
  await wait(1200);
  assert.strictEqual((await stats(first)).locked, true);
  await closeZalo();
});

test("turning on with one tab reloads it and opens a second", async () => {
  await openZalo();
  await wait(800);
  await toggle();
  await popup.waitForSelector("#toast:not([hidden])");
  await waitForZaloTabs(2);
  assert.strictEqual((await coreScripts()).length, 1);
  await wait(3500);
});

test("on: one hub, no lock, no kick, replies reach the right tab", async () => {
  const kicks = server.kicks;
  const tabs = await assertLive(2500);
  for (const s of tabs) assert.deepStrictEqual([s.locked, s.kicked, s.badResp], [false, 0, 0]);
  assert.deepStrictEqual(tabs.map((s) => s.role).sort(), ["follower", "hub"]);
  assert.strictEqual(server.kicks, kicks, "server saw a second connection");
});

test("badge shows from 3 tabs", async () => {
  assert.strictEqual(await badge(), "");
  await openZalo();
  await wait(1500);
  assert.strictEqual(await badge(), "3");
  assert.strictEqual(await popup.textContent("#badge"), "3");
  assert.ok(await popup.isVisible("#badge"));
});

test("closing the hub hands over to another tab", async () => {
  const pages = zaloPages();
  const roles = await Promise.all(pages.map(stats));
  await pages[roles.findIndex((s) => s.role === "hub")].close();
  await wait(4000);
  const tabs = await assertLive(2000);
  assert.deepStrictEqual(tabs.map((s) => s.role).sort(), ["follower", "hub"]);
});

test("turning off unregisters the core script and clears the badge", async () => {
  await toggle();
  await wait(1500);
  assert.deepStrictEqual(await coreScripts(), []);
  assert.strictEqual(await badge(), "");
  await closeZalo();
});

test("auto-reload off: 'Reload N tabs' applies the mode", async () => {
  await popup.click("#auto");
  const tab = await openZalo();
  await wait(800);
  await toggle();
  await popup.waitForSelector("#pending:not([hidden])");
  assert.strictEqual(await popup.textContent("#pending"), "Reload 1 tab");
  assert.strictEqual(await tab.evaluate(() => !!window.__ztabs), false, "tab changed mode without a reload");
  await popup.click("#pending");
  await waitForZaloTabs(2);
  await wait(2000);
  for (const p of zaloPages()) assert.ok(await p.evaluate(() => !!window.__ztabs));
});

test("no handshake within 10 s: falls back to single-tab mode", async () => {
  await closeZalo();
  const tab = await openZalo("?nohs");
  await wait(11500);
  assert.ok(await tab.evaluate(() => window.__ztabs.status().degraded));
});
