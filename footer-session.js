/**
 * Live footer: visitor public IP + America/Bogota Spanish date/time.
 * Expects #footer-ip and #footer-date (or fills #footer-meta).
 */
(function () {
  var DAYS = [
    "Domingo",
    "Lunes",
    "Martes",
    "Miércoles",
    "Jueves",
    "Viernes",
    "Sábado",
  ];
  var MONTHS = [
    "Enero",
    "Febrero",
    "Marzo",
    "Abril",
    "Mayo",
    "Junio",
    "Julio",
    "Agosto",
    "Septiembre",
    "Octubre",
    "Noviembre",
    "Diciembre",
  ];
  var TZ = "America/Bogota";

  function ensureNodes() {
    var meta = document.getElementById("footer-meta");
    var ipEl = document.getElementById("footer-ip");
    var dateEl = document.getElementById("footer-date");
    if (!meta && !ipEl && !dateEl) return null;
    if (!meta) {
      meta = document.createElement("p");
      meta.id = "footer-meta";
      meta.className = "site-footer__meta";
      var foot = document.querySelector(".site-footer");
      if (foot) foot.appendChild(meta);
    }
    if (!ipEl || !dateEl) {
      meta.innerHTML =
        'Dirección IP: <span id="footer-ip">—</span><br /><span id="footer-date"></span>';
      ipEl = document.getElementById("footer-ip");
      dateEl = document.getElementById("footer-date");
    }
    return { ipEl: ipEl, dateEl: dateEl };
  }

  function bogotaParts(d) {
    var fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    var parts = {};
    fmt.formatToParts(d).forEach(function (p) {
      if (p.type !== "literal") parts[p.type] = p.value;
    });
    // weekday from en-US short → map via Date in Bogota calendar fields
    var cal = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      weekday: "short",
    });
    var map = {};
    cal.formatToParts(d).forEach(function (p) {
      if (p.type !== "literal") map[p.type] = p.value;
    });
    var weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[
      map.weekday
    ];
    var monthIndex = parseInt(map.month, 10) - 1;
    var dayNum = parseInt(map.day, 10);
    var year = parseInt(map.year, 10);
    var hour24 = parseInt(map.hour, 10);
    if (map.hour === "24") hour24 = 0;
    var minute = map.minute;
    var ampm = hour24 >= 12 ? "p. m." : "a. m.";
    var h12 = hour24 % 12;
    if (h12 === 0) h12 = 12;
    return (
      DAYS[weekdayIndex] +
      ", " +
      dayNum +
      " de " +
      MONTHS[monthIndex] +
      " de " +
      year +
      ", " +
      h12 +
      ":" +
      minute +
      " " +
      ampm
    );
  }

  function renderDate(nodes) {
    if (!nodes || !nodes.dateEl) return;
    nodes.dateEl.textContent = bogotaParts(new Date());
  }

  function fetchIp(nodes) {
    if (!nodes || !nodes.ipEl) return;
    nodes.ipEl.textContent = "—";
    var controllers = [];
    function tryUrl(url) {
      return fetch(url, { cache: "no-store" })
        .then(function (r) {
          if (!r.ok) throw new Error("bad status");
          var ct = r.headers.get("content-type") || "";
          if (ct.indexOf("application/json") !== -1) {
            return r.json().then(function (j) {
              return j.ip || j.query || null;
            });
          }
          return r.text().then(function (t) {
            return String(t).trim();
          });
        })
        .then(function (ip) {
          if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error("bad ip");
          return ip;
        });
    }

    tryUrl("https://api.ipify.org?format=json")
      .catch(function () {
        return tryUrl("https://api64.ipify.org?format=json");
      })
      .catch(function () {
        return tryUrl("https://ipapi.co/ip/");
      })
      .then(function (ip) {
        nodes.ipEl.textContent = ip;
      })
      .catch(function () {
        nodes.ipEl.textContent = "—";
      });
  }

  function init() {
    var nodes = ensureNodes();
    if (!nodes) return;
    renderDate(nodes);
    fetchIp(nodes);
    setInterval(function () {
      renderDate(nodes);
    }, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
