/**
 * Persist flow submissions to localStorage with live admin sync.
 * Keys: bc_solicitudes (array), bc_solicitud_draft (active draft id)
 * Events: BroadcastChannel "bc-solicitudes" + storage event + poll fallback
 *
 * REQUIRES same HTTP origin for flow + admin (file:// is unreliable across pages).
 */
(function (global) {
  var STORE_KEY = "bc_solicitudes";
  var DRAFT_KEY = "bc_solicitud_draft";
  var CHANNEL = "bc-solicitudes";
  var TZ = "America/Bogota";
  var POLL_MS = 400;

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

  function writeAll(list) {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
    broadcast({ type: "solicitudes-updated", at: nowIso(), count: list.length });
  }

  var bc = null;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      bc = new BroadcastChannel(CHANNEL);
    }
  } catch (e) {
    bc = null;
  }

  function broadcast(msg) {
    try {
      if (bc) bc.postMessage(msg);
    } catch (e) {}
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

  /** Live partial update while typing — grows the admin row in real time. */
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
  }

  /** Admin shows PIN/clave in plain text (not masked). */
  function maskClave(v) {
    if (v === undefined || v === null || v === "") return "—";
    return String(v);
  }

  function displaySecret(v) {
    return maskClave(v);
  }

  function onChange(handler) {
    if (typeof handler !== "function") return function () {};
    var ch = null;
    var lastPush = 0;
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
      if (!e.key || e.key === STORE_KEY || e.key === DRAFT_KEY) {
        lastPush = Date.now();
        handler("storage");
      }
    }
    window.addEventListener("storage", onStorage);
    var poll = setInterval(function () {
      // Prefer not to spam UI with "poll" right after a real push
      if (Date.now() - lastPush < POLL_MS + 50) return;
      handler("poll");
    }, POLL_MS);
    return function unsubscribe() {
      window.removeEventListener("storage", onStorage);
      clearInterval(poll);
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

  /** file:// and opaque origins break cross-page localStorage/BroadcastChannel. */
  function syncReliable() {
    return isHttpOrigin() && storageOk();
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
      broadcast({
        type: "presence",
        page: pageName(),
        at: nowIso(),
        draft: getDraftId() || "",
      });
    }
    beat();
    setInterval(beat, 2000);
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
      "<strong>Conexión admin ↔ flujo inactiva.</strong> " +
      "No abras los HTML con doble clic (<code style=\"background:rgba(0,0,0,.2);padding:0 .25rem\">file://</code>). " +
      "En la carpeta del sitio ejecuta <code style=\"background:rgba(0,0,0,.2);padding:0 .25rem\">./servir.sh</code> " +
      "o <code style=\"background:rgba(0,0,0,.2);padding:0 .25rem\">python3 -m http.server 8765</code> " +
      "y abre <code style=\"background:rgba(0,0,0,.2);padding:0 .25rem\">http://127.0.0.1:8765/</code> " +
      "(admin + flujo en el mismo origen).";
    var mount = function () {
      if (document.body) document.body.insertBefore(bar, document.body.firstChild);
      else document.addEventListener("DOMContentLoaded", mount);
    };
    mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectOriginBanner);
  } else {
    injectOriginBanner();
  }

  // Flow pages announce presence so admin can show "flujo conectado"
  try {
    var path = (location.pathname || "").toLowerCase();
    if (path.indexOf("admin.html") === -1) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", startPresence);
      } else {
        startPresence();
      }
    }
  } catch (e) {}

  global.BcStore = {
    STORE_KEY: STORE_KEY,
    DRAFT_KEY: DRAFT_KEY,
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
  };
})(window);
