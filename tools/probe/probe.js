// Logs metadata only (key names, lengths, frame headers, field names), never message content or tokens.
(() => {
  if (window.__zprobe) return;

  const CFG_KEY = "__zprobe_cfg";
  const MAX_EVENTS = 5000;
  const MAX_SAMPLES_PER_KEY = 3;
  const TAB = Math.random().toString(36).slice(2, 8);
  const FRAME = window === window.top ? "top" : "iframe";
  const T0 = Date.now();

  let REAL_LS = null; // captured before window.localStorage may be wrapped in a Proxy
  try {
    REAL_LS = window.localStorage;
  } catch (_) {}
  const nativeGetItem = Storage.prototype.getItem;
  const nativeSetItem = Storage.prototype.setItem;
  const nativeRemoveItem = Storage.prototype.removeItem;

  let cfg = {};
  try {
    // Per-tab config that survives reloads.
    cfg = JSON.parse(nativeGetItem.call(window.sessionStorage, CFG_KEY) || "{}") || {};
  } catch (_) {}

  const events = [];
  const counts = {};
  let dropped = 0;

  // ---------- helpers ----------

  function stack(depth = 10) {
    const prev = Error.stackTraceLimit;
    Error.stackTraceLimit = depth + 5;
    const raw = new Error().stack || "";
    Error.stackTraceLimit = prev;
    return raw
      .split("\n")
      .slice(1)
      .map((s) => s.trim())
      .filter((s) => s && !s.includes("chrome-extension://") && !s.startsWith("Error"))
      .slice(0, depth);
  }

  function shape(v, depth = 0) {
    if (v === null || v === undefined) return String(v);
    const t = typeof v;
    if (t === "string") return `str(${v.length})`;
    if (t === "number" || t === "boolean") return t;
    if (t === "function") return "fn";
    if (v instanceof ArrayBuffer) return `ArrayBuffer(${v.byteLength})`;
    if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${v.byteLength})`;
    if (typeof Blob !== "undefined" && v instanceof Blob) return `Blob(${v.size})`;
    if (Array.isArray(v)) return depth > 2 ? `Array(${v.length})` : [`x${v.length}`, v.length ? shape(v[0], depth + 1) : null];
    if (depth > 2) return "obj";
    const out = {};
    for (const k of Object.keys(v).slice(0, 30)) out[k] = shape(v[k], depth + 1);
    return out;
  }

  function sanitizeUrl(u) {
    try {
      const url = new URL(String(u), location.href);
      const params = [...url.searchParams.keys()];
      return url.origin + url.pathname + (params.length ? `?{${params.join(",")}}` : "");
    } catch (_) {
      return "unparsable";
    }
  }

  // aggKey: repeated events keep only the first MAX_SAMPLES_PER_KEY samples.
  function log(type, data = {}, { withStack = true, aggKey = null } = {}) {
    const key = aggKey || type;
    counts[key] = (counts[key] || 0) + 1;
    if (aggKey && counts[key] > MAX_SAMPLES_PER_KEY) return;
    if (events.length >= MAX_EVENTS) {
      dropped++;
      return;
    }
    const ev = { t: Date.now() - T0, ...data, type };
    if (withStack) ev.stack = stack();
    events.push(ev);
    if (cfg.verbose || data.important) console.debug(`[zprobe ${TAB}]`, type, ev);
  }

  // Shows what triggered an action.
  function recent(n) {
    return events.slice(-n).map((e) => `${e.t} ${e.type}${e.key ? " " + e.key : ""}${e.name ? " " + e.name : ""}${e.frame ? " cmd=" + e.frame.cmd : ""}`);
  }

  // Zalo frame: [version u8][cmd u16 LE][subCmd u8] + UTF-8 JSON.
  function describeFrame(buf) {
    const u8 = new Uint8Array(buf);
    if (u8.byteLength < 4) return { bytes: u8.byteLength };
    const version = u8[0];
    const cmd = u8[1] | (u8[2] << 8);
    const subCmd = u8[3];
    const out = { bytes: u8.byteLength, version, cmd, subCmd };
    try {
      const text = new TextDecoder().decode(u8.subarray(4));
      if (text) out.body = shape(JSON.parse(text));
    } catch (_) {
      out.body = "non-json";
    }
    return out;
  }

  function logFrame(dir, data) {
    const emit = (info) => {
      const sig = info.cmd !== undefined ? `${info.version}/${info.cmd}/${info.subCmd}` : "text";
      const extra = {};
      if (info.cmd === 3000) extra.important = "DUPLICATE CONNECTION — server báo có kết nối khác";
      if (info.cmd === 1 && info.subCmd === 1) extra.note = "handshake (cipher key) — không ghi key";
      log(
        dir,
        { frame: info, ...extra },
        {
          withStack: dir !== "ws.recv",
          aggKey: extra.important ? null : `${dir} ${sig}`,
        },
      );
    };
    if (typeof data === "string") {
      let body = "non-json";
      try {
        body = shape(JSON.parse(data));
      } catch (_) {}
      emit({ text: true, length: data.length, body });
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      emit(describeFrame(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      data.arrayBuffer().then(
        (b) => emit(describeFrame(b)),
        () => {},
      );
    }
  }

  // ---------- WebSocket ----------

  const NativeWS = window.WebSocket;

  class FakeWS extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0; // stays CONNECTING forever
      this.protocol = "";
      this.extensions = "";
      this.bufferedAmount = 0;
      this.binaryType = "blob";
      this.onopen = this.onclose = this.onmessage = this.onerror = null;
    }
    send(d) {
      logFrame("ws.send(blocked)", d);
    }
    close(code, reason) {
      log("ws.close(fake)", { code, reason });
      if (this.readyState === 3) return;
      this.readyState = 3;
      const ev = new CloseEvent("close", { code: code || 1000, reason: reason || "", wasClean: true });
      this.dispatchEvent(ev);
      if (this.onclose) this.onclose(ev);
    }
  }
  Object.assign(FakeWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  if (NativeWS) {
    const nativeSend = NativeWS.prototype.send;
    const nativeClose = NativeWS.prototype.close;
    NativeWS.prototype.send = function (d) {
      logFrame("ws.send", d);
      return nativeSend.call(this, d);
    };
    NativeWS.prototype.close = function (code, reason) {
      log("ws.close() called by page", {
        url: sanitizeUrl(this.url),
        code,
        reason,
        important: "client tự đóng socket",
        fullStack: stack(40),
        recent: recent(20),
      });
      return nativeClose.apply(this, arguments);
    };
    window.WebSocket = new Proxy(NativeWS, {
      construct(target, args, newTarget) {
        const url = sanitizeUrl(args[0]);
        log("ws.new", { url, blocked: !!cfg.blockWS, important: "mở websocket" });
        if (cfg.blockWS) return new FakeWS(args[0]);
        const ws = Reflect.construct(target, args, newTarget);
        ws.addEventListener("open", () => log("ws.open", { url, important: "ws open" }, { withStack: false }));
        ws.addEventListener("error", () => log("ws.error", { url }, { withStack: false }));
        ws.addEventListener("close", (e) =>
          log("ws.closed", { url, code: e.code, reason: e.reason, wasClean: e.wasClean, important: "ws closed" }, { withStack: false }),
        );
        ws.addEventListener("message", (e) => logFrame("ws.recv", e.data));
        return ws;
      },
    });
  }

  // ---------- BroadcastChannel ----------

  const NativeBC = window.BroadcastChannel;
  if (NativeBC) {
    const realName = new WeakMap();
    const nativePost = NativeBC.prototype.postMessage;
    NativeBC.prototype.postMessage = function (d) {
      const name = realName.get(this) || this.name;
      log("bc.send", { name, data: shape(d), muted: !!cfg.muteBC }, { aggKey: `bc.send ${name} ${JSON.stringify(shape(d)).slice(0, 120)}` });
      return nativePost.call(this, d);
    };
    window.BroadcastChannel = new Proxy(NativeBC, {
      construct(target, args, newTarget) {
        const name = String(args[0]);
        log("bc.new", { name, muted: !!cfg.muteBC, important: "BroadcastChannel" });
        // muteBC: a per-tab channel name cuts this tab off from the others.
        const effective = cfg.muteBC ? `${name}__zprobe_${TAB}` : name;
        const bc = Reflect.construct(target, [effective, ...args.slice(1)], newTarget);
        realName.set(bc, name);
        bc.addEventListener("message", (e) =>
          log("bc.recv", { name, data: shape(e.data) }, { withStack: false, aggKey: `bc.recv ${name} ${JSON.stringify(shape(e.data)).slice(0, 120)}` }),
        );
        return bc;
      },
    });
  }

  // ---------- Storage ----------

  function storageKind(s) {
    try {
      return s === REAL_LS ? "local" : s === window.sessionStorage ? "session" : "?";
    } catch (_) {
      return "?";
    }
  }
  const SINGLETON_KEY = "sh_singleton_web_app";
  let ownSingleton = null;
  Storage.prototype.setItem = function (k, v) {
    if (k === SINGLETON_KEY && storageKind(this) === "local") {
      ownSingleton = String(v);
      log("singleton.set", { valueLength: ownSingleton.length, important: "tab này nhận quyền singleton" });
    } else if (k !== CFG_KEY)
      log("storage.set", { store: storageKind(this), key: String(k), valueLength: String(v).length }, { aggKey: `storage.set ${storageKind(this)} ${k}` });
    return nativeSetItem.call(this, k, v);
  };
  Storage.prototype.getItem = function (k) {
    if (k === SINGLETON_KEY && storageKind(this) === "local") {
      const real = nativeGetItem.call(this, k);
      const spoof = !!(cfg.muteSingleton && ownSingleton !== null && real !== ownSingleton);
      log("singleton.get", { matchesOwn: real === ownSingleton, spoofed: spoof }, { aggKey: `singleton.get ${real === ownSingleton} ${spoof}` });
      return spoof ? ownSingleton : real;
    }
    return nativeGetItem.call(this, k);
  };
  Storage.prototype.removeItem = function (k) {
    log("storage.remove", { store: storageKind(this), key: String(k) }, { aggKey: `storage.remove ${storageKind(this)} ${k}` });
    return nativeRemoveItem.call(this, k);
  };

  // Property reads (localStorage.sh_singleton_web_app) bypass getItem.
  const lsDesc = Object.getOwnPropertyDescriptor(Window.prototype, "localStorage") || Object.getOwnPropertyDescriptor(window, "localStorage");
  if (lsDesc && lsDesc.get && cfg.muteSingleton) {
    let proxied = null;
    try {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          const real = lsDesc.get.call(window);
          if (!proxied || proxied.real !== real) {
            proxied = {
              real,
              proxy: new Proxy(real, {
                get(target, prop) {
                  if (prop === SINGLETON_KEY) {
                    const v = nativeGetItem.call(target, prop);
                    const spoof = !!(cfg.muteSingleton && ownSingleton !== null && v !== ownSingleton);
                    log(
                      "singleton.get",
                      { via: "property", matchesOwn: v === ownSingleton, spoofed: spoof },
                      { aggKey: `singleton.get.prop ${v === ownSingleton} ${spoof}` },
                    );
                    return spoof ? ownSingleton : v === null ? undefined : v;
                  }
                  const v = Reflect.get(target, prop, target);
                  return typeof v === "function" ? v.bind(target) : v;
                },
                set(target, prop, value) {
                  if (typeof prop === "string" && prop !== "length") {
                    target.setItem(prop, value); // through the setItem hook so it is logged
                    return true;
                  }
                  return Reflect.set(target, prop, value, target);
                },
              }),
            };
          }
          return proxied.proxy;
        },
      });
    } catch (e) {
      log("probe.warn", { msg: "không bọc được window.localStorage: " + e });
    }
  }

  // muteStorage drops every storage event; muteSingleton only the singleton key's.
  function wrapStorageListener(listener) {
    if (cfg.muteStorage) return function () {};
    if (!cfg.muteSingleton) return null;
    return function (e) {
      if (e && e.key === SINGLETON_KEY) {
        log("singleton.event.dropped", { important: "chặn tín hiệu khoá tab từ tab khác" }, { withStack: false, aggKey: "singleton.event.dropped" });
        return;
      }
      return typeof listener === "function" ? listener.call(this, e) : listener.handleEvent(e);
    };
  }
  const WATCHED = new Set(["storage", "visibilitychange", "beforeunload", "pagehide", "unload", "freeze"]);
  const wrappedListeners = new WeakMap();
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, opts) {
    if (WATCHED.has(type) && (this === window || this === document)) {
      const s = stack();
      log("listener.add", { target: this === window ? "window" : "document", event: type }, { aggKey: `listener.add ${type} ${s[1] || ""}` });
      const w = type === "storage" && listener ? wrapStorageListener(listener) : null;
      if (w) {
        wrappedListeners.set(listener, w);
        return nativeAdd.call(this, type, w, opts);
      }
    }
    return nativeAdd.call(this, type, listener, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, opts) {
    return nativeRemove.call(this, type, (listener && wrappedListeners.get(listener)) || listener, opts);
  };
  const onstorageDesc = Object.getOwnPropertyDescriptor(window, "onstorage") || Object.getOwnPropertyDescriptor(Window.prototype, "onstorage");
  if (onstorageDesc && onstorageDesc.set) {
    Object.defineProperty(window, "onstorage", {
      configurable: true,
      get() {
        return onstorageDesc.get.call(window);
      },
      set(fn) {
        log("listener.add", { target: "window", event: "storage", via: "onstorage" });
        onstorageDesc.set.call(window, fn ? wrapStorageListener(fn) || fn : fn);
      },
    });
  }
  nativeAdd.call(window, "storage", (e) => {
    if (e.key === SINGLETON_KEY)
      log(
        "singleton.event",
        {
          newValueLength: e.newValue == null ? null : e.newValue.length,
          muted: !!(cfg.muteStorage || cfg.muteSingleton),
          important: "tab khác lấy quyền singleton",
        },
        { withStack: false },
      );
    else
      log(
        "storage.event",
        { key: e.key, newValueLength: e.newValue == null ? null : e.newValue.length, muted: !!cfg.muteStorage },
        { withStack: false, aggKey: `storage.event ${e.key}` },
      );
  });
  nativeAdd.call(document, "visibilitychange", () => log("visibility", { state: document.visibilityState }, { withStack: false }));

  // ---------- Web Locks ----------

  if (navigator.locks) {
    const LM = Object.getPrototypeOf(navigator.locks);
    const nativeRequest = LM.request;
    const nativeQuery = LM.query;
    LM.request = function (name, a, b) {
      const opts = typeof a === "function" ? {} : a || {};
      const cb = typeof a === "function" ? a : b;
      log("locks.request", { name, mode: opts.mode, ifAvailable: opts.ifAvailable, steal: opts.steal, muted: !!cfg.muteLocks, important: "Web Lock" });
      if (cfg.muteLocks) return Promise.resolve().then(() => cb({ name, mode: opts.mode || "exclusive" }));
      return nativeRequest
        .call(this, name, opts, (lock) => {
          log("locks.granted", { name, granted: !!lock, important: lock ? "lock granted" : "lock NOT available" }, { withStack: false });
          return cb(lock);
        })
        .then(
          (r) => (log("locks.released", { name }, { withStack: false }), r),
          (e) => (log("locks.error", { name, error: String(e) }, { withStack: false }), Promise.reject(e)),
        );
    };
    LM.query = function () {
      log("locks.query", {}, { aggKey: "locks.query" });
      return nativeQuery.call(this);
    };
  }

  // ---------- Workers ----------

  for (const W of ["Worker", "SharedWorker"]) {
    const Native = window[W];
    if (!Native) continue;
    window[W] = new Proxy(Native, {
      construct(target, args, newTarget) {
        log(`${W}.new`, { url: sanitizeUrl(args[0]), options: shape(args[1]), important: W });
        const w = Reflect.construct(target, args, newTarget);
        if (W === "SharedWorker") {
          const port = w.port;
          const post = port.postMessage.bind(port);
          port.postMessage = (d, t) => {
            log("SharedWorker.send", { data: shape(d) }, { aggKey: `SharedWorker.send ${JSON.stringify(shape(d)).slice(0, 120)}` });
            return post(d, t);
          };
        }
        return w;
      },
    });
  }
  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    const reg = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = (url, o) => (log("serviceWorker.register", { url: sanitizeUrl(url) }), reg(url, o));
  }

  // ---------- HTTP (fetch / XHR): method, host, path and status; never query or body ----------

  const SKIP_HTTP = /\.(js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp3|mp4|webm|json)$/i;
  function apiPath(u) {
    try {
      const url = new URL(String(u), location.href);
      return url.host + url.pathname;
    } catch (_) {
      return "?";
    }
  }
  function logHttp(via, method, path, status, t0, error) {
    if (SKIP_HTTP.test(path)) return;
    const data = { via, method, path, status, ms: Date.now() - t0 };
    if (error) data.error = error;
    log("http", data, { withStack: false, aggKey: `http ${method} ${path} ${status}` });
  }
  if (window.fetch) {
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input && input.url;
      const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      const path = apiPath(url);
      const t0 = Date.now();
      const p = nativeFetch.apply(this, arguments);
      p.then(
        (r) => logHttp("fetch", method, path, r.status, t0),
        (e) => logHttp("fetch", method, path, 0, t0, String(e)),
      );
      return p;
    };
  }
  if (window.XMLHttpRequest) {
    const xhrInfo = new WeakMap();
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeXSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      xhrInfo.set(this, { method: String(method).toUpperCase(), path: apiPath(url) });
      return nativeOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const info = xhrInfo.get(this);
      if (info) {
        const t0 = Date.now();
        this.addEventListener("loadend", () => logHttp("xhr", info.method, info.path, this.status, t0));
      }
      return nativeXSend.apply(this, arguments);
    };
  }

  // ---------- IndexedDB ----------

  if (window.IDBFactory) {
    const nativeOpen = IDBFactory.prototype.open;
    const nativeDelete = IDBFactory.prototype.deleteDatabase;
    IDBFactory.prototype.open = function (name, version) {
      log("idb.open", { name, version }, { aggKey: `idb.open ${name}` });
      const req = nativeOpen.apply(this, arguments);
      req.addEventListener("blocked", (e) =>
        log("idb.blocked", { name, oldVersion: e.oldVersion, newVersion: e.newVersion, important: "IDB blocked" }, { withStack: false }),
      );
      req.addEventListener("success", () => {
        const db = req.result;
        db.addEventListener("versionchange", (e) =>
          log("idb.versionchange", { name, oldVersion: e.oldVersion, newVersion: e.newVersion, important: "tab khác nâng version IDB" }, { withStack: false }),
        );
        db.addEventListener("close", () => log("idb.closed", { name }, { withStack: false }));
      });
      return req;
    };
    IDBFactory.prototype.deleteDatabase = function (name) {
      log("idb.delete", { name, important: "xoá IDB" });
      return nativeDelete.apply(this, arguments);
    };
  }

  // ---------- UI: detect the "open in another tab" screen ----------

  const LOCK_TEXT =
    /tab kh[aá]c|c[uử]a s[oổ] kh[aá]c|d[uù]ng t[aạ]i [dđ][aâ]y|s[uử] d[uụ]ng t[aạ]i [dđ][aâ]y|[dđ]ang [dđ][uư][oợ]c m[oở]|another (tab|window)|use here/i;
  const seenTexts = new Set();
  function scan(node) {
    if (node.nodeType !== 1) return;
    const text = (node.textContent || "").trim();
    if (!text || text.length > 400 || !LOCK_TEXT.test(text) || seenTexts.has(text)) return;
    seenTexts.add(text);
    log(
      "ui.lockText",
      { text: text.slice(0, 200), tag: node.tagName, className: String(node.className).slice(0, 120), important: "UI khoá tab xuất hiện?" },
      { withStack: false },
    );
  }
  function startObserver() {
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) scan(n);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.documentElement) startObserver();
  else nativeAdd.call(document, "readystatechange", startObserver, { once: true });

  // ---------- Console / popup API ----------

  function report() {
    return {
      tab: TAB,
      frame: FRAME,
      page: sanitizeUrl(location.href),
      userAgent: navigator.userAgent,
      startedAt: new Date(T0).toISOString(),
      cfg,
      counts,
      dropped,
      events,
    };
  }

  window.__zprobe = {
    tab: TAB,
    log,
    cfg,
    events,
    counts,
    report,
    set(partial) {
      Object.assign(cfg, partial);
      nativeSetItem.call(window.sessionStorage, CFG_KEY, JSON.stringify(cfg));
      return cfg;
    },
    reset() {
      nativeRemoveItem.call(window.sessionStorage, CFG_KEY);
    },
    mark(label) {
      log("mark", { label: String(label || "").slice(0, 80), important: "MARK " + String(label || "") }, { withStack: false });
    },
    important() {
      return events.filter((e) => e.important);
    },
    summary() {
      console.table(counts);
      return counts;
    },
    download() {
      const blob = new Blob([JSON.stringify(report(), null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `zprobe-${TAB}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },
  };

  log("probe.start", { frame: FRAME, page: sanitizeUrl(location.href), cfg: { ...cfg } }, { withStack: false });
  console.info(`[zprobe] tab=${TAB} cfg=`, cfg, "— dùng __zprobe.important(), __zprobe.download()");
})();
