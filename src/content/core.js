// Runs in chat.zalo.me's MAIN world at document_start, before any Zalo script.
(() => {
  if (window.__ztabs || window !== window.top) return;

  const TAB = Math.random().toString(36).slice(2, 8);
  const LOCK = "ztabs:hub";
  const CHANNEL = "ztabs:relay";
  const SINGLETON_KEY = "sh_singleton_web_app";
  const VIRTUAL_HOST = /-msg\.chat\.zalo\.me$/; // chat socket only; calls etc. connect directly
  const PENDING_TTL_MS = 15000;
  const CONNECT_RETRY_MS = 1000;
  const CONNECT_MAX_TRIES = 15;
  const HANDSHAKE_TIMEOUT_MS = 10000;
  const HUB_IDLE_CLOSE_MS = 3000;

  const debug = (() => {
    try {
      return window.sessionStorage.getItem("ztabs:debug") === "1";
    } catch (_) {
      return false;
    }
  })();
  const log = (...a) => debug && console.debug("[ztabs]", TAB, ...a);

  // ---------- Singleton lock: ignore other tabs' claims ----------

  let realLocal = null;
  try {
    realLocal = window.localStorage;
  } catch (_) {}
  const nativeGetItem = Storage.prototype.getItem;
  const nativeSetItem = Storage.prototype.setItem;
  let ownSingleton = null;

  Storage.prototype.setItem = function (k, v) {
    if (this === realLocal && k === SINGLETON_KEY) ownSingleton = String(v);
    return nativeSetItem.call(this, k, v);
  };
  Storage.prototype.getItem = function (k) {
    if (this === realLocal && k === SINGLETON_KEY && ownSingleton !== null) return ownSingleton;
    return nativeGetItem.call(this, k);
  };

  // Property reads (localStorage.sh_singleton_web_app) bypass getItem.
  const lsDesc = Object.getOwnPropertyDescriptor(Window.prototype, "localStorage");
  if (realLocal && lsDesc && lsDesc.get) {
    const proxy = new Proxy(realLocal, {
      get(target, prop) {
        if (prop === SINGLETON_KEY) {
          const v = ownSingleton !== null ? ownSingleton : nativeGetItem.call(target, prop);
          return v === null ? undefined : v;
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
      set(target, prop, value) {
        if (typeof prop === "string") {
          target.setItem(prop, value);
          return true;
        }
        return Reflect.set(target, prop, value, target);
      },
    });
    try {
      Object.defineProperty(window, "localStorage", { configurable: true, get: () => proxy });
    } catch (_) {}
  }

  // Registered first (document_start, capture), so Zalo's listeners and onstorage never see other tabs' claims.
  window.addEventListener("storage", (e) => e.key === SINGLETON_KEY && e.stopImmediatePropagation(), true);

  // ---------- Shared websocket ----------

  const NativeWS = window.WebSocket;
  const bc = new BroadcastChannel(CHANNEL);
  let degraded = false;

  function header(buf) {
    const u8 = new Uint8Array(buf);
    return u8.byteLength >= 4 ? { cmd: u8[1] | (u8[2] << 8), sub: u8[3] } : { cmd: -1, sub: -1 };
  }
  function toArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return Promise.resolve(data);
    if (ArrayBuffer.isView(data)) return Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (data instanceof Blob) return data.arrayBuffer();
    return Promise.resolve(new TextEncoder().encode(String(data)).buffer);
  }
  function parseBody(buf) {
    try {
      return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4)));
    } catch (_) {
      return null;
    }
  }
  // Requests carry reqId/eventId at the top level; responses may nest it.
  function findId(o, depth) {
    if (!o || typeof o !== "object" || depth > 3) return null;
    for (const k of ["reqId", "eventId"]) if (o[k] !== undefined && o[k] !== null) return String(o[k]);
    if (depth === 3) return null;
    for (const v of Object.values(o)) {
      const r = v && typeof v === "object" ? findId(v, depth + 1) : null;
      if (r) return r;
    }
    return null;
  }
  function b64ToBytes(s) {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function importCipherKey(body) {
    if (!body || typeof body.key !== "string") return Promise.resolve(null);
    return crypto.subtle.importKey("raw", b64ToBytes(body.key), { name: "AES-GCM" }, false, ["decrypt"]).catch(() => null);
  }
  // Zalo's `encrypt` field: 0 = plain JSON, 1 = base64+zlib, 2 = AES-GCM+zlib, 3 = AES-GCM.
  async function decodeData(body, key) {
    if (typeof body.data !== "string" || typeof body.encrypt !== "number") return null;
    const t = body.encrypt;
    if (t === 0) return JSON.parse(body.data);
    let bytes = b64ToBytes(t === 1 ? body.data : decodeURIComponent(body.data));
    if (t !== 1) {
      if (!key || bytes.length < 48) return null;
      const alg = { name: "AES-GCM", iv: bytes.subarray(0, 16), additionalData: bytes.subarray(16, 32), tagLength: 128 };
      bytes = new Uint8Array(await crypto.subtle.decrypt(alg, key, bytes.subarray(32)));
    }
    if (t !== 3) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // ---------- VirtualWS: what the app sees ----------

  const sockets = new Map(); // id → VirtualWS of this tab
  let seq = 0;

  class VirtualWS extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.protocol = "";
      this.extensions = "";
      this.bufferedAmount = 0;
      this.binaryType = "blob";
      this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._id = `${TAB}:${++seq}`;
      this._via = null; // "local" (this tab is the hub) | "remote"
      this._chain = Promise.resolve();
      sockets.set(this._id, this);
      router.connect(this);
    }
    send(data) {
      if (this.readyState === 0) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", "InvalidStateError");
      if (this.readyState !== 1) return;
      this._chain = this._chain.then(() => toArrayBuffer(data)).then((buf) => router.send(this, buf));
    }
    close(code = 1000, reason = "") {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      router.close(this);
      this._closed(code, reason, true);
    }
    _opened() {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this._fire(new Event("open"), "onopen");
    }
    _message(buf) {
      if (this.readyState !== 1) return;
      const data = this.binaryType === "arraybuffer" ? buf : new Blob([buf]);
      this._fire(new MessageEvent("message", { data }), "onmessage");
    }
    _closed(code, reason, wasClean) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      clearInterval(this._retry);
      sockets.delete(this._id);
      this._fire(new CloseEvent("close", { code, reason, wasClean }), "onclose");
    }
    _fire(ev, prop) {
      this.dispatchEvent(ev);
      if (typeof this[prop] === "function") this[prop].call(this, ev);
    }
  }
  for (const target of [VirtualWS, VirtualWS.prototype]) Object.assign(target, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  window.WebSocket = new Proxy(NativeWS, {
    construct(target, args, newTarget) {
      let host = "";
      try {
        host = new URL(String(args[0])).host;
      } catch (_) {}
      if (degraded || !VIRTUAL_HOST.test(host)) return Reflect.construct(target, args, newTarget);
      return new VirtualWS(args[0]);
    },
  });

  // ---------- Roles ----------

  let role = "pending"; // "pending" | "hub" | "follower"
  const waiting = [];
  let releaseLock = null;

  const router = {
    connect(v) {
      if (role === "hub") {
        v._via = "local";
        hubConnect({ key: v._id, tab: TAB, local: v, url: v.url });
      } else if (role === "follower") {
        v._via = "remote";
        followerConnect(v);
      } else waiting.push(v);
    },
    send(v, buf) {
      if (v.readyState !== 1) return;
      if (v._via === "local") hubSend(v._id, buf);
      else bc.postMessage({ k: "send", tab: TAB, sock: v._id, data: buf });
    },
    close(v) {
      if (v._via === "local") hubClientClose(v._id);
      else if (v._via === "remote") bc.postMessage({ k: "close", tab: TAB, sock: v._id });
    },
  };

  function flushWaiting() {
    while (waiting.length) {
      const v = waiting.shift();
      if (v.readyState === 0) router.connect(v);
    }
  }

  function becomeHub() {
    role = "hub";
    log("role: hub");
    bc.postMessage({ k: "hub-up", tab: TAB });
    for (const v of [...sockets.values()]) {
      if (v.readyState === 1) v._closed(1006, "ztabs: became hub", false);
      else if (v.readyState === 0 && v._via === "remote") {
        clearInterval(v._retry);
        v._via = "local";
        hubConnect({ key: v._id, tab: TAB, local: v, url: v.url });
      }
    }
    flushWaiting();
  }

  function requestHubLock() {
    navigator.locks.request(LOCK, () => {
      if (degraded) return;
      becomeHub();
      return new Promise((resolve) => (releaseLock = resolve));
    });
  }
  requestHubLock();
  navigator.locks.query().then((st) => {
    if (role === "pending" && st.held.some((l) => l.name === LOCK)) {
      role = "follower";
      log("role: follower");
      flushWaiting();
    }
  });

  // ---------- Follower ----------

  function followerConnect(v) {
    let tries = 0;
    const ask = () => bc.postMessage({ k: "connect", tab: TAB, sock: v._id, url: v.url });
    ask();
    v._retry = setInterval(() => {
      if (v.readyState !== 0 || v._via !== "remote") return clearInterval(v._retry);
      if (++tries >= CONNECT_MAX_TRIES) return v._closed(1006, "ztabs: no hub", false);
      ask();
    }, CONNECT_RETRY_MS);
  }

  // ---------- Hub ----------

  const hub = {
    ws: null,
    handshake: null,
    cipherKey: null,
    handshakeTimer: null,
    clients: new Map(),
    pending: new Map(), // cmd → [{ key, ts, id }]
    recvChain: Promise.resolve(),
    idleTimer: null,
  };

  function hubConnect(c) {
    if (hub.clients.has(c.key)) return;
    c.opened = false;
    hub.clients.set(c.key, c);
    clearTimeout(hub.idleTimer);
    if (!hub.ws) hubOpenReal(c.url);
    else if (hub.handshake) hubOpenClient(c);
  }

  function hubOpenReal(url) {
    hub.handshake = null;
    hub.cipherKey = null;
    hub.pending.clear();
    const ws = new NativeWS(url);
    ws.binaryType = "arraybuffer";
    hub.ws = ws;
    ws.addEventListener("message", (e) => {
      // Sequential: decryption is async but per-tab frame order must hold.
      hub.recvChain = hub.recvChain
        .then(() => toArrayBuffer(e.data))
        .then((buf) => hub.ws === ws && hubRecv(buf))
        .catch((err) => log("recv error", err));
    });
    ws.addEventListener("close", (e) => hubRealClosed(ws, e.code, e.reason));
    clearTimeout(hub.handshakeTimer);
    hub.handshakeTimer = setTimeout(() => {
      if (hub.ws === ws && !hub.handshake) degrade("no handshake");
    }, HANDSHAKE_TIMEOUT_MS);
    log("real socket opened");
  }

  function hubOpenClient(c) {
    c.opened = true;
    if (c.local) {
      c.local._opened();
      c.local._message(hub.handshake.slice(0));
    } else {
      bc.postMessage({ k: "open", to: c.tab, sock: c.key });
      bc.postMessage({ k: "msg", to: c.tab, sock: c.key, data: hub.handshake });
    }
  }

  function deliver(c, buf) {
    if (!c || !c.opened) return;
    if (c.local) c.local._message(buf.slice(0));
    else bc.postMessage({ k: "msg", to: c.tab, sock: c.key, data: buf });
  }

  async function hubRecv(buf) {
    const { cmd, sub } = header(buf);
    if (cmd === 1 && sub === 1) {
      const first = !hub.handshake;
      hub.handshake = buf;
      clearTimeout(hub.handshakeTimer);
      hub.cipherKey = await importCipherKey(parseBody(buf));
      if (first) {
        for (const c of hub.clients.values()) if (!c.opened) hubOpenClient(c);
        return;
      }
    }
    const now = Date.now();
    const q = (hub.pending.get(cmd) || []).filter((p) => hub.clients.has(p.key) && now - p.ts < PENDING_TTL_MS);
    if (hub.pending.has(cmd)) hub.pending.set(cmd, q);
    if (!q.length) {
      for (const c of hub.clients.values()) deliver(c, buf);
      return;
    }
    if (q.every((p) => p.key === q[0].key)) return deliver(hub.clients.get(q.shift().key), buf);
    const body = parseBody(buf);
    let id = findId(body, 0);
    if (!id && body) id = findId(await decodeData(body, hub.cipherKey).catch(() => null), 0);
    const idx = id ? q.findIndex((p) => p.id === id) : -1;
    deliver(hub.clients.get((idx >= 0 ? q.splice(idx, 1)[0] : q.shift()).key), buf);
  }

  function hubSend(key, buf) {
    if (!hub.ws || hub.ws.readyState !== 1 || !hub.clients.has(key)) return;
    const { cmd } = header(buf);
    if (!hub.pending.has(cmd)) hub.pending.set(cmd, []);
    hub.pending.get(cmd).push({ key, ts: Date.now(), id: findId(parseBody(buf), 1) });
    hub.ws.send(buf);
  }

  function hubClientClose(key) {
    if (!hub.clients.delete(key)) return;
    if (hub.clients.size === 0 && hub.ws) {
      clearTimeout(hub.idleTimer);
      hub.idleTimer = setTimeout(() => {
        if (hub.clients.size === 0 && hub.ws) hub.ws.close(1000);
      }, HUB_IDLE_CLOSE_MS);
    }
  }

  function closeClient(c, code, reason) {
    if (c.local) c.local._closed(code, reason, code === 1000);
    else bc.postMessage({ k: "closed", to: c.tab, sock: c.key, code, reason });
  }

  function hubRealClosed(ws, code, reason) {
    if (hub.ws !== ws) return;
    log("real socket closed", code, reason);
    clearTimeout(hub.handshakeTimer);
    hub.ws = null;
    hub.handshake = null;
    hub.cipherKey = null;
    hub.pending.clear();
    const clients = [...hub.clients.values()];
    hub.clients.clear();
    for (const c of clients) closeClient(c, code, reason);
  }

  // ---------- Safety ----------

  // Unknown protocol: every tab falls back to plain Zalo Web.
  function degrade(reason, fromPeer) {
    if (degraded) return;
    degraded = true;
    console.warn("[ztabs] falling back to single-tab mode:", reason);
    if (!fromPeer) bc.postMessage({ k: "degraded", reason });
    if (hub.ws) hub.ws.close(1000);
    for (const v of [...sockets.values()]) v._closed(1006, "ztabs: fallback", false);
    if (releaseLock) releaseLock();
  }

  // A frozen hub would stall every tab: hand the role over first.
  document.addEventListener("freeze", () => {
    if (role !== "hub") return;
    log("frozen — releasing hub");
    for (const c of hub.clients.values()) if (!c.local) bc.postMessage({ k: "closed", to: c.tab, sock: c.key, code: 1006, reason: "ztabs: hub frozen" });
    if (hub.ws) hub.ws.close(1001);
    role = "follower";
    if (releaseLock) releaseLock();
    releaseLock = null;
  });
  document.addEventListener("resume", () => {
    if (role === "follower" && !releaseLock && !degraded) requestHubLock();
  });

  window.addEventListener("pagehide", () => {
    if (role === "hub") {
      for (const c of hub.clients.values()) if (!c.local) bc.postMessage({ k: "closed", to: c.tab, sock: c.key, code: 1006, reason: "ztabs: hub left" });
    } else bc.postMessage({ k: "tab-gone", tab: TAB });
  });

  // ---------- Relay channel ----------

  bc.onmessage = (e) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    switch (m.k) {
      case "connect":
        if (role === "hub") hubConnect({ key: m.sock, tab: m.tab, url: m.url });
        break;
      case "send":
        if (role === "hub") hubSend(m.sock, m.data);
        break;
      case "close":
        if (role === "hub") hubClientClose(m.sock);
        break;
      case "tab-gone":
        if (role === "hub") for (const [k, c] of [...hub.clients]) if (c.tab === m.tab) hubClientClose(k);
        break;
      case "open":
        if (m.to === TAB && sockets.has(m.sock)) sockets.get(m.sock)._opened();
        break;
      case "msg":
        if (m.to === TAB && sockets.has(m.sock)) sockets.get(m.sock)._message(m.data);
        break;
      case "closed":
        if (m.to === TAB && sockets.has(m.sock)) sockets.get(m.sock)._closed(m.code, m.reason, m.code === 1000);
        break;
      case "hub-up":
        if (m.tab !== TAB && role !== "hub") {
          if (role === "pending") {
            role = "follower";
            flushWaiting();
          }
          for (const v of [...sockets.values()]) if (v.readyState === 1) v._closed(1006, "ztabs: hub changed", false);
        }
        break;
      case "degraded":
        degrade(m.reason, true);
        break;
    }
  };

  window.__ztabs = {
    status: () => ({
      tab: TAB,
      role,
      degraded,
      sockets: [...sockets.values()].map((v) => ({ id: v._id, via: v._via, readyState: v.readyState })),
      hub: role === "hub" ? { realState: hub.ws ? hub.ws.readyState : null, handshake: !!hub.handshake, clients: hub.clients.size } : null,
    }),
  };
})();
