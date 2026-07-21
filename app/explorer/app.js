/* NIGHTPASS Passport Explorer.
 *
 * A public, account-free single-page explorer over the anonymous
 * PassportService surface, in the spirit of a block explorer:
 *   list    #/            this network's anchored passports (anchorExplorer)
 *   detail  #/p/<id>      full anchor record + LIVE ledger verification
 *
 * Data endpoints (all anonymous):
 *   GET /api/v1/passport/anchorExplorer()             list
 *   GET /api/v1/passport/verifyOnChain(passportId=..) live indexer read
 *   GET /api/v1/passport/runtime-config               server network
 *   GET /qr/<id>.png                                  QR for the viewer landing
 *
 * Motion layer: anime.js v4, vendored same-origin (CSP). Strictly progressive
 * enhancement; every animation call is wrapped so a missing/broken library or
 * prefers-reduced-motion leaves a fully working, static app.
 */
"use strict";

// ---------- motion engine (anime.js, optional) ----------

var A = null; // the anime.js module, or null (no motion)
try {
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced) A = await import("./vendor/anime.esm.js");
} catch (e) { A = null; }

/** Run an animation; never let motion break the app. */
function fx(targets, params) {
  if (!A) return;
  try { A.animate(targets, params); } catch (e) { /* static fallback */ }
}

/** One-shot CSS animation via class (removed on end); motion-safe. */
function flash(el, cls) {
  if (!A || !el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // restart the CSS animation
  el.classList.add(cls);
  el.addEventListener("animationend", function h() {
    el.classList.remove(cls);
    el.removeEventListener("animationend", h);
  });
}

/** Count an element's number up from 0 (instant without motion). */
function countUp(el, target) {
  if (!el) return;
  if (!A || !isFinite(target) || target <= 0) { el.textContent = String(target); return; }
  var o = { n: 0 };
  try {
    A.animate(o, {
      n: target, duration: 900, ease: "outExpo",
      modifier: A.utils.round(0),
      onUpdate: function () { el.textContent = String(o.n); },
      onComplete: function () { el.textContent = String(target); }
    });
  } catch (e) { el.textContent = String(target); }
}

/** Animate an inline checkmark's path (line drawing). */
function drawCheck(scope) {
  if (!A || !scope) return;
  try {
    var path = scope.querySelector(".check path");
    if (!path) return;
    var d = A.svg.createDrawable(path);
    A.animate(d, { draw: "0 1", duration: 450, ease: "outQuad" });
  } catch (e) { /* check simply shows drawn */ }
}

function checkSvg() {
  return '<svg class="check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M2.5 8.5l3.5 3.5 7-8" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

/**
 * Scramble-decode a hash element: random hex resolves left-to-right into the
 * real value (the "read from the ledger" moment). The REAL text is already in
 * the DOM before this runs, so copy/a11y/fallback always see the final value.
 */
function scrambleIn(el, delayMs) {
  if (!A || !el) return;
  var finalText = el.textContent;
  if (!finalText || finalText.length > 80) return;
  var HEX = "0123456789abcdef";
  var o = { p: 0 };
  try {
    A.animate(o, {
      p: 1, duration: 700, delay: delayMs || 0, ease: "outQuad",
      onUpdate: function () {
        var keep = Math.floor(o.p * finalText.length);
        var out = finalText.slice(0, keep);
        for (var i = keep; i < finalText.length; i++) {
          out += HEX[(Math.random() * 16) | 0];
        }
        el.textContent = out;
      },
      onComplete: function () { el.textContent = finalText; }
    });
  } catch (e) { el.textContent = finalText; }
}

var API = "/api/v1/passport";
  var state = { rows: [], network: "", query: "", page: 1, crossVerify: false, peerNets: [], explorerLinks: {}, viewerBase: null, loaded: false, fingerprint: "" };
  var app = document.getElementById("app");

  // ---------- utils ----------

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function shortHash(h) {
    if (!h) return "";
    return h.length > 20 ? h.slice(0, 10) + "…" + h.slice(-6) : h;
  }
  function relTime(iso) {
    if (!iso) return "";
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!isFinite(s) || s < 0) return "";
    if (s < 90) return "just now";
    var m = s / 60, h = m / 60;
    if (m < 90) return Math.round(m) + " min ago";
    if (h < 24) return Math.round(h) + " h ago";
    // From one day on: days AND remaining hours ("1 d 2 h ago", "3 d ago").
    var days = Math.floor(h / 24);
    var restH = Math.round(h - days * 24);
    if (restH === 24) { days += 1; restH = 0; }
    return days + " d" + (restH ? " " + restH + " h" : "") + " ago";
  }
  function verifyUrl(pid) {
    return API + "/verifyOnChain(passportId=" +
      encodeURIComponent("'" + String(pid).replace(/'/g, "''") + "'") + ")";
  }
  function chip(status) {
    return '<span class="chip ' + esc(status) + '">' + esc(status || "unknown") + "</span>";
  }
  function netBadge(net) {
    if (!net) return '<span class="net">&ndash;</span>';
    return '<span class="net ' + esc(net) + '">' + esc(net) + "</span>";
  }
  function crossNetwork(row) {
    return !!(row.anchorNetwork && state.network && row.anchorNetwork !== state.network);
  }
  // Can this row's anchor be live-verified from here (own network, plugin
  // network override, or a delegating peer instance for that network)?
  function verifiable(row) {
    if (row.status !== "anchored") return false;
    if (!crossNetwork(row)) return true;
    return state.crossVerify || state.peerNets.indexOf(row.anchorNetwork) >= 0;
  }
  function copyBtn(value) {
    return '<button class="copy" data-copy="' + esc(value) + '" title="Copy">&#10697;</button>';
  }

  // ---------- proven ZK claims ----------

  var CLAIM_FIELD_LABELS = {
    carbonFootprintKgCO2: "CO₂ footprint",
    capacityKwh: "Capacity",
    recycledContentPct: "Recycled content",
    cycleLife: "Cycle life",
    roundTripEfficiencyPct: "Round-trip efficiency",
    leadContentPpm: "Lead content",
    recycledCoPct: "Recycled cobalt share",
    recycledLiPct: "Recycled lithium share",
    recycledNiPct: "Recycled nickel share"
  };

  function claimLabel(field) {
    return CLAIM_FIELD_LABELS[field] || field;
  }
  function claimBound(claim) {
    var op = claim.predicate === "greaterOrEqual" ? "≥" : "≤";
    var n = Number(claim.threshold);
    var num = isFinite(n) ? String(+n.toFixed(3)) : esc(String(claim.threshold));
    return op + " " + num + (claim.unit ? " " + esc(claim.unit) : "");
  }
  function shieldSvg() {
    return '<svg class="shield" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
      '<path d="M8 1.5l5 2v4c0 3.2-2.1 5.5-5 7-2.9-1.5-5-3.8-5-7v-4z" fill="none" ' +
      'stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
      '<path d="M5.6 8l1.7 1.7 3-3.4" fill="none" stroke="currentColor" stroke-width="1.4" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  /** Small list-row badge: how many ZK-proven claims this passport carries. */
  function claimsBadge(row) {
    var n = (row.claims || []).length;
    if (!n) return "";
    var tip = row.claims.map(function (c) { return claimLabel(c.sourceField) + " " + claimBound(c); }).join("\n");
    return '<span class="zk-chip" title="' + esc(tip) + '">' + shieldSvg() + n + " ZK</span>";
  }

  // ---------- recently anchored ticker ----------

  /** The most recently anchored passports, newest first. Reuses the explorer
   * feed (no separate endpoint); a small live strip above the stat tiles. */
  function recentAnchored(rows) {
    return rows.filter(function (r) { return r.status === "anchored" && r.createdAt; })
      .slice()
      .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0; })
      .slice(0, 8);
  }

  function tickerHtml(rows) {
    var recent = recentAnchored(rows);
    if (!recent.length) return "";
    var items = recent.map(function (r) {
      return '<a class="tick" href="#/p/' + encodeURIComponent(r.passportId) + '">' +
        '<span class="tick-dot"></span>' +
        '<span class="tick-pid mono">' + esc(r.passportId) + "</span>" +
        (r.claims && r.claims.length ? '<span class="tick-zk">' + r.claims.length + " ZK</span>" : "") +
        '<span class="tick-age">' + esc(relTime(r.createdAt)) + "</span></a>";
    }).join("");
    return '<section class="ticker" aria-label="Recently anchored">' +
      '<span class="ticker-label">Recently anchored</span>' +
      '<div class="ticker-track">' + items + "</div></section>";
  }

  // ---------- data ----------

  // A cheap signature of the row set: changes only when a passport is added,
  // re-anchored, or its claims change. Drives the poll's re-render guard.
  function rowsFingerprint(rows) {
    return rows.map(function (r) {
      return r.passportId + ":" + r.status + ":" + r.createdAt + ":" + (r.claims || []).length;
    }).join("|");
  }

  function load() {
    var pNet = fetch(API + "/runtime-config")
      .then(function (r) { return r.json(); })
      .catch(function () { return {}; });
    var pRows = fetch(API + "/anchorExplorer()")
      .then(function (r) {
        if (!r.ok) throw new Error("anchorExplorer failed (" + r.status + ")");
        return r.json();
      })
      .then(function (b) { return b.value || []; });
    return Promise.all([pNet, pRows]).then(function (res) {
      state.network = res[0].network || "";
      // Server capabilities for rows anchored on ANOTHER network: the NIGHTGATE
      // `network` override covers any network; peer instances cover the listed
      // ones (server delegates the live check to them).
      state.crossVerify = res[0].crossNetworkVerify === true;
      state.peerNets = res[0].peerNetworks || [];
      state.explorerLinks = res[0].explorerLinks || {};
      // Base URL of the tiered viewer: '' = co-hosted (relative links), a URL
      // = the internal work instance, null = pure explorer surface (no link).
      state.viewerBase = res[0].viewerBase !== undefined ? res[0].viewerBase : "";
      state.rows = res[1];
      state.fingerprint = rowsFingerprint(state.rows);
      state.loaded = true;
      entranceDone = false; // fresh data, fresh entrance
      var badge = document.getElementById("networkBadge");
      badge.textContent = state.network ? "midnight · " + state.network : "midnight";
      // One instance = ONE network. The other networks' explorers are separate
      // instances, reachable via these header links (PASSPORT_EXPLORER_LINKS).
      var sw = document.getElementById("netSwitch");
      if (sw) {
        sw.innerHTML = Object.keys(state.explorerLinks).sort().map(function (n) {
          return '<a class="net-badge alt" href="' + esc(state.explorerLinks[n]) + '">' + esc(n) + " &#8599;</a>";
        }).join("");
      }
    });
  }

  /** The rows THIS instance explores: anchored work on its own network only.
   * Drafts and failed anchor attempts are producer-internal state, not part
   * of the public record. */
  function ownRows() {
    return state.rows.filter(function (r) {
      return r.anchorNetwork === state.network && r.status !== "draft" && r.status !== "failed";
    });
  }

  /** ownRows narrowed by the active search filter (list order = newest first). */
  function filteredRows() {
    var q = state.query.trim().toLowerCase();
    var all = ownRows();
    return !q ? all : all.filter(function (r) {
      return [r.passportId, r.model, r.payloadHash, r.attestationTxHash, r.status]
        .some(function (v) { return String(v || "").toLowerCase().indexOf(q) >= 0; });
    });
  }

  // The table paginates from 11 rows on: 10 per page, page 1 = the newest.
  var PAGE_SIZE = 10;

  function pageCount(rows) {
    return Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  }

  function currentPageRows() {
    var rows = filteredRows();
    var page = Math.min(Math.max(1, state.page), pageCount(rows));
    return rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  }

  // ---------- list view ----------

  // ---------- hero: the animated "anchor ring" ----------

  var RING_R = 104;
  var RING_C = 2 * Math.PI * RING_R;

  function ringSvg(share) {
    var ticks = "";
    for (var i = 0; i < 64; i++) {
      var a = (i / 64) * Math.PI * 2;
      var inner = i % 8 === 0 ? 118 : 125;
      ticks += '<line x1="' + (140 + Math.cos(a) * 132).toFixed(1) + '" y1="' + (140 + Math.sin(a) * 132).toFixed(1) +
        '" x2="' + (140 + Math.cos(a) * inner).toFixed(1) + '" y2="' + (140 + Math.sin(a) * inner).toFixed(1) + '"/>';
    }
    var offset = (RING_C * (1 - share)).toFixed(1);
    return '<svg viewBox="0 0 280 280" class="ring-svg" aria-hidden="true">' +
      '<g class="ring-ticks">' + ticks + "</g>" +
      '<circle class="ring-track" cx="140" cy="140" r="' + RING_R + '"/>' +
      '<circle id="ringArc" class="ring-arc" cx="140" cy="140" r="' + RING_R + '" ' +
        'style="stroke-dasharray:' + RING_C.toFixed(1) + ';stroke-dashoffset:' + offset + '" data-offset="' + offset + '"/>' +
      "</svg>";
  }

  function heroHtml(rows) {
    var anchored = rows.filter(function (r) { return r.status === "anchored"; }).length;
    var share = rows.length ? anchored / rows.length : 0;
    return '<section class="hero">' +
      '<div class="hero-copy">' +
        "<h1>Every battery.<br/><em>Anchored on Midnight.</em></h1>" +
        '<p class="hero-sub">EU battery passports, hash-anchored in a zero-knowledge attestation vault on Midnight ' +
          esc(state.network || "") + ". Verify any of them against the ledger. Live, right here, no account.</p>" +
      "</div>" +
      '<div class="hero-ring" id="heroRing">' + ringSvg(share) +
        '<div class="ring-center">' +
          '<div class="ring-count num" data-n="' + anchored + '">' + anchored + "</div>" +
          '<div class="ring-label">anchored on</div>' + netBadge(state.network) +
        "</div></div>" +
      "</section>";
  }

  /** Pulse the hero ring once (a row just verified). */
  function pulseRing() {
    var ring = document.getElementById("heroRing");
    if (!ring) return;
    fx(ring, {
      scale: 1.045, duration: 150, ease: "outQuad",
      onComplete: function () { fx(ring, { scale: 1, duration: 320, ease: "outQuad" }); }
    });
  }

  // Entrance choreography: staggered tiles/rows, ring fade + arc sweep,
  // number count-ups. Once per load, not on every re-render (search).
  var entranceDone = false;
  function animateList() {
    Array.prototype.forEach.call(document.querySelectorAll("#app .num"), function (el) {
      if (!entranceDone) countUp(el, Number(el.getAttribute("data-n")));
    });
    if (!A || entranceDone) { entranceDone = true; return; }
    entranceDone = true;
    fx("#app .stat", { opacity: { from: 0, to: 1 }, y: { from: 14, to: 0 }, delay: A.stagger(60), duration: 500, ease: "outQuad" });
    fx("#app tbody tr", { opacity: { from: 0, to: 1 }, y: { from: 10, to: 0 }, delay: A.stagger(28), duration: 400, ease: "outQuad" });
    fx("#heroRing", { opacity: { from: 0, to: 1 }, scale: { from: 0.94, to: 1 }, duration: 700, ease: "outQuad" });
    fx(".hero-copy", { opacity: { from: 0, to: 1 }, y: { from: 10, to: 0 }, duration: 500, ease: "outQuad" });
    var arc = document.getElementById("ringArc");
    if (arc) {
      fx(arc, { strokeDashoffset: { from: RING_C, to: Number(arc.getAttribute("data-offset")) }, duration: 1400, ease: "outQuad" });
    }
  }

  function statTiles(rows) {
    var anchored = rows.filter(function (r) { return r.status === "anchored"; }).length;
    var newest = rows.reduce(function (acc, r) {
      return r.createdAt && (!acc || r.createdAt > acc) ? r.createdAt : acc;
    }, "");
    var vault = "";
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].contractAddress) { vault = rows[i].contractAddress; break; }
    }
    return '<section class="stats" aria-label="Statistics">' +
      '<div class="stat"><div class="label">Passports on ' + esc(state.network || "?") + '</div><div class="value num" data-n="' + rows.length + '">' + rows.length + "</div>" +
        '<div class="hint">anchored work on this network</div></div>' +
      '<div class="stat"><div class="label">Verified anchors</div><div class="value num" data-n="' + anchored + '">' + anchored + "</div>" +
        '<div class="hint">payload hash in the attestation vault</div></div>' +
      '<div class="stat"><div class="label">Latest passport</div><div class="value" style="font-size:18px;line-height:2">' + esc(relTime(newest) || "–") + "</div>" +
        '<div class="hint">' + esc(newest ? new Date(newest).toLocaleString() : "") + "</div></div>" +
      '<div class="stat"><div class="label">Attestation vault</div><div class="value mono" style="font-size:18px;line-height:2" title="' + esc(vault) + '">' + esc(shortHash(vault) || "–") + "</div>" +
        '<div class="hint">the on-chain contract holding the anchors</div></div>' +
      "</section>";
  }

  function rowHtml(row, i) {
    var pid = esc(row.passportId);
    var cross = crossNetwork(row);
    var canVerify = verifiable(row);
    var initialState = cross && !canVerify
      ? '<span class="vstate info">anchored on ' + esc(row.anchorNetwork) + "</span>"
      : "";
    return "<tr data-pid=\"" + pid + "\">" +
      '<td class="mono"><a href="#/p/' + encodeURIComponent(row.passportId) + '">' + pid + "</a>" +
        '<div class="sub">' + esc(row.model || "") + "</div></td>" +
      "<td>" + chip(row.status) + claimsBadge(row) + "</td>" +
      '<td class="mono" title="' + esc(row.payloadHash || "") + '">' + esc(shortHash(row.payloadHash)) + "</td>" +
      '<td class="mono">' + (row.explorerUrl
        ? '<a href="' + esc(row.explorerUrl) + '" target="_blank" rel="noopener" title="' + esc(row.attestationTxHash || "") + '">' + esc(shortHash(row.attestationTxHash)) + "</a>"
        : "&ndash;") + "</td>" +
      "<td>" + esc(relTime(row.createdAt)) + "</td>" +
      '<td><button class="btn verify-row" data-i="' + i + '"' + (canVerify ? "" : " disabled") + ">Verify</button> " +
        '<span class="vstate" id="vs-' + i + '">' + initialState + "</span></td>" +
      "</tr>";
  }

  // ONE instance, ONE network: the list shows only this network's anchored
  // passports. Other networks live in their own instances behind the header /
  // stat-tile links (PASSPORT_EXPLORER_LINKS). No drafts here.
  function pagerHtml(rows) {
    var pages = pageCount(rows);
    if (pages <= 1) return "";
    var btns = "";
    for (var p = 1; p <= pages; p++) {
      btns += '<button class="btn page-btn' + (p === state.page ? " primary" : "") + '" data-page="' + p + '"' +
        (p === state.page ? " disabled" : "") + ">" + p + "</button>";
    }
    return '<div class="pager">' +
      '<button class="btn page-btn" data-page="' + (state.page - 1) + '"' + (state.page <= 1 ? " disabled" : "") + ">&lsaquo; Newer</button>" +
      btns +
      '<button class="btn page-btn" data-page="' + (state.page + 1) + '"' + (state.page >= pages ? " disabled" : "") + ">Older &rsaquo;</button>" +
      '<span class="pager-info">page ' + state.page + " of " + pages + " &middot; " + rows.length + " passports</span>" +
      "</div>";
  }

  function renderList() {
    var q = state.query.trim().toLowerCase();
    var all = ownRows();
    var rows = filteredRows();
    state.page = Math.min(Math.max(1, state.page), pageCount(rows));
    var body = currentPageRows().map(function (r) { return rowHtml(r, state.rows.indexOf(r)); }).join("");
    app.innerHTML =
      heroHtml(all) +
      tickerHtml(all) +
      statTiles(all) +
      '<section class="panel">' +
        '<div class="panel-head"><h2>Midnight ' + netBadge(state.network) + " passports" +
          (q ? " · filter: “" + esc(state.query) + "”" : "") + "</h2>" +
          '<div class="actions">' +
            '<button class="btn primary" id="verifyAll">Verify all on Midnight</button>' +
            '<button class="btn" id="reload" title="Reload">&#8635;</button>' +
          "</div></div>" +
        '<div class="table-wrap"><table>' +
          "<thead><tr><th>Passport</th><th>Status</th><th>Payload hash</th><th>Attestation tx</th><th>Age</th><th>On-chain verification</th></tr></thead>" +
          "<tbody>" + (body || '<tr><td colspan="6"><div class="empty">No passports match.</div></td></tr>') + "</tbody>" +
        "</table></div>" +
        pagerHtml(rows) +
      "</section>";

    document.getElementById("reload").addEventListener("click", function () {
      load().then(render);
    });
    Array.prototype.forEach.call(app.querySelectorAll(".page-btn"), function (btn) {
      btn.addEventListener("click", function () {
        state.page = Number(btn.dataset.page);
        renderList();
      });
    });
    document.getElementById("verifyAll").addEventListener("click", verifyAll);
    Array.prototype.forEach.call(app.querySelectorAll(".verify-row"), function (btn) {
      btn.addEventListener("click", function () { verifyRow(Number(btn.dataset.i)); });
    });
    // A click anywhere on a row opens the passport's detail page; links and
    // buttons inside the row keep their own behavior. Selecting text (e.g. a
    // hash to copy) does not navigate.
    Array.prototype.forEach.call(app.querySelectorAll("tbody tr[data-pid]"), function (tr) {
      tr.addEventListener("click", function (ev) {
        if (ev.target.closest("a, button")) return;
        if (String(window.getSelection && window.getSelection())) return;
        location.hash = "#/p/" + encodeURIComponent(tr.getAttribute("data-pid"));
      });
    });
    animateList();
  }

  function setRowState(i, cls, text) {
    var el = document.getElementById("vs-" + i);
    if (!el) return;
    el.innerHTML = '<span class="vstate ' + cls + '">' + (cls === "ok" ? checkSvg() : "") + esc(text) + "</span>";
    if (cls === "ok") {
      drawCheck(el);
      flash(el.closest("tr"), "row-glow");
      pulseRing();
    } else if (cls === "warn" || cls === "err") {
      flash(el, "shake");
    }
  }

  function verifyRow(i) {
    var row = state.rows[i];
    if (!row) return Promise.resolve();
    setRowState(i, "info checking", "checking…");
    return fetch(verifyUrl(row.passportId))
      .then(function (r) { return r.json(); })
      .then(function (b) {
        if (b.verified === true) {
          var onNet = b.checkedNetwork && b.checkedNetwork !== state.network
            ? " on " + b.checkedNetwork : "";
          setRowState(i, "ok", "verified" + onNet);
        } else {
          setRowState(i, "warn", "not confirmed");
        }
      })
      .catch(function () { setRowState(i, "err", "check failed"); });
  }

  // Sequential on purpose: one indexer read at a time keeps the endpoint
  // polite. Sweeps the rows of the CURRENT page (the visible ones).
  function verifyAll() {
    var chain = Promise.resolve();
    currentPageRows().forEach(function (row) {
      if (verifiable(row)) {
        var i = state.rows.indexOf(row);
        chain = chain.then(function () { return verifyRow(i); });
      }
    });
  }

  // ---------- detail view ----------

  function kv(label, valueHtml) {
    return "<div>" + esc(label) + "</div><div>" + (valueHtml || "&ndash;") + "</div>";
  }

  /** "Proven claims" panel: one badge per ZK-proven predicate. The exact value
   * never appears; only the claim, its bound and the on-chain proof tx. Each
   * claim can be LIVE-verified against the vault's ledger state (button). */
  function claimsPanelHtml(row, canVerify) {
    var claims = row.claims || [];
    if (!claims.length) return "";
    return '<section class="panel">' +
      '<div class="panel-head"><h2>Proven claims</h2>' +
        '<span class="net" title="Zero-knowledge predicate proofs on Midnight">zero-knowledge</span></div>' +
      '<p class="claims-note">The exact values stay confidential. Each claim was proven in zero-knowledge ' +
        "against this passport's anchored content and carries its own on-chain proof transaction.</p>" +
      '<div class="claims">' + claims.map(function (c, i) {
        var tx = !c.txHash ? "" :
          c.explorerUrl
            ? '<a href="' + esc(c.explorerUrl) + '" target="_blank" rel="noopener" class="mono" title="' + esc(c.txHash) + '">' + esc(shortHash(c.txHash)) + "</a>"
            : '<span class="mono" title="' + esc(c.txHash) + '">' + esc(shortHash(c.txHash)) + "</span>";
        return '<div class="claim">' +
          '<span class="claim-shield">' + shieldSvg() + "</span>" +
          '<span class="claim-field">' + esc(claimLabel(c.sourceField)) + "</span>" +
          '<span class="claim-bound">' + claimBound(c) + "</span>" +
          '<span class="claim-proof">proven in ZK' + (tx ? " &middot; tx " + tx : "") + "</span>" +
          '<span class="claim-verify"><button class="btn verify-claim" data-ci="' + i + '"' + (canVerify ? "" : " disabled") + ">Verify</button> " +
            '<span class="vstate" id="cvs-' + i + '"></span></span>' +
          "</div>";
      }).join("") + "</div></section>";
  }

  function verifyClaimUrl(pid, c) {
    var q = (s) => encodeURIComponent("'" + String(s).replace(/'/g, "''") + "'");
    return API + "/verifyClaimOnChain(passportId=" + q(pid) +
      ",sourceField=" + q(c.sourceField) + ",predicate=" + q(c.predicate) +
      ",threshold=" + encodeURIComponent(String(c.threshold)) + ")";
  }

  function renderDetail(pid) {
    var row = state.rows.find(function (r) { return r.passportId === pid; });
    if (!row) {
      app.innerHTML = '<div class="crumbs"><a href="#/">&larr; All passports</a></div>' +
        '<section class="panel"><div class="empty">No passport with ID <span class="mono">' + esc(pid) + "</span>.</div></section>";
      return;
    }
    var cross = crossNetwork(row);
    var canVerify = verifiable(row);
    var viewerLink = state.viewerBase == null ? "" :
      '<a href="' + esc(state.viewerBase + "/p/" + encodeURIComponent(row.passportId)) +
      '" target="_blank" rel="noopener">Open in Passport Viewer</a>';
    app.innerHTML =
      '<div class="crumbs"><a href="#/">&larr; All passports</a></div>' +
      '<div class="detail-head"><h1>' + esc(row.passportId) + "</h1>" + chip(row.status) + netBadge(row.anchorNetwork) + "</div>" +
      '<div class="detail-grid">' +
        '<div class="col">' +
        '<section class="panel">' +
          '<div class="panel-head"><h2>Public product information</h2>' +
            '<span class="net" title="EU Battery Regulation 2023/1542">Annex XIII &middot; Point 1</span></div>' +
          '<div class="kv">' +
            kv("Model", esc(row.model) + (row.batteryCategory ? ' <span class="sub">(' + esc(row.batteryCategory) + ")</span>" : "")) +
            kv("Manufacturer", esc(row.manufacturerId)) +
            kv("Manufacture date", row.manufactureDate ? esc(row.manufactureDate) : "") +
            kv("Weight (kg)", row.weightKg != null ? esc(String(row.weightKg)) : "") +
            kv("Performance class", row.performanceClass ? esc(row.performanceClass) : "") +
            kv("Passport URL", row.qrCodeUrl
              ? '<a href="' + esc(row.qrCodeUrl) + '" target="_blank" rel="noopener" class="mono">' + esc(row.qrCodeUrl) + "</a>"
              : "") +
          "</div>" +
        "</section>" +
        '<section class="panel">' +
          '<div class="panel-head"><h2>On-chain anchor</h2>' +
            '<div class="actions"><button class="btn primary" id="verifyBtn"' + (canVerify ? "" : " disabled") + ">Verify on Midnight</button></div></div>" +
          '<div id="verifyBanner"></div>' +
          '<div class="kv">' +
            kv("Status", chip(row.status)) +
            kv("Anchor network", netBadge(row.anchorNetwork) + (cross && !canVerify ? ' <span class="vstate info">this explorer verifies ' + esc(state.network) + "</span>" : "")) +
            kv("Payload hash", row.payloadHash ? '<span class="mono">' + esc(row.payloadHash) + "</span> " + copyBtn(row.payloadHash) : "") +
            kv("Vault contract", row.contractAddress ? '<span class="mono">' + esc(row.contractAddress) + "</span> " + copyBtn(row.contractAddress) : "") +
            kv("Attestation tx", row.attestationTxHash
              ? '<span class="mono">' + esc(row.attestationTxHash) + "</span> " + copyBtn(row.attestationTxHash) +
                (row.explorerUrl ? ' &middot; <a href="' + esc(row.explorerUrl) + '" target="_blank" rel="noopener">open in Midnight explorer</a>' : "")
              : "") +
            kv("Created", row.createdAt ? esc(new Date(row.createdAt).toLocaleString()) + ' <span class="sub">(' + esc(relTime(row.createdAt)) + ")</span>" : "") +
          "</div>" +
        "</section>" +
        claimsPanelHtml(row, canVerify) +
        "</div>" +
        '<section class="panel qr-card">' +
          '<img src="/qr/' + encodeURIComponent(row.passportId) + '.png" alt="QR code for ' + esc(row.passportId) + '"/>' +
          '<div class="hint">Scan to open the tiered passport viewer</div>' +
          '<div class="links">' +
            viewerLink +
            (row.payloadHash ? '<a href="#" id="credDl">Download verifiable credential (JSON)</a>' : "") +
          "</div>" +
        "</section>" +
      "</div>";

    var banner = document.getElementById("verifyBanner");
    function showBanner(cls, text, sub) {
      banner.innerHTML = '<div class="verify-banner ' + cls + '">' + (cls === "ok" ? checkSvg() : "") + esc(text) +
        (sub ? '<span class="sub">' + esc(sub) + "</span>" : "") + "</div>";
      if (cls === "ok") {
        drawCheck(banner);
        flash(document.querySelector(".detail-head .net"), "glow-pulse");
        pulseRing();
      }
    }

    function runVerify() {
      showBanner("", "Checking the Midnight ledger…");
      fetch(verifyUrl(row.passportId))
        .then(function (r) { return r.json(); })
        .then(function (b) {
          if (b.verified === true) {
            showBanner("ok", "Verified on Midnight",
              "The payload hash is anchored in the attestation vault on " + (b.checkedNetwork || b.serverNetwork || "the network") + ". Checked live at " + new Date(b.checkedAt).toLocaleTimeString() + ".");
          } else if (!b.checkedNetwork && b.anchorNetwork && b.serverNetwork && b.anchorNetwork !== b.serverNetwork) {
            showBanner("warn", "Anchored on " + b.anchorNetwork,
              "This explorer verifies against " + b.serverNetwork + ", so the live check cannot run here. Use the Midnight explorer link below as proof.");
          } else if (b.status === "anchored") {
            showBanner("warn", "Not confirmed",
              "The live ledger read" + (b.checkedNetwork ? " on " + b.checkedNetwork : "") + " did not confirm the anchor (indexer unreachable?). Try again.");
          } else {
            showBanner("warn", "Not anchored yet", "Status: " + (b.status || "draft") + ". No on-chain anchor to verify.");
          }
        })
        .catch(function () { showBanner("err", "Check failed", "Could not reach the verification endpoint."); });
    }

    var vBtn = document.getElementById("verifyBtn");
    vBtn.addEventListener("click", runVerify);

    // Per-claim live verification: read the vault's ledger state for exactly
    // this claim key. Same capability rules as the anchor verify.
    Array.prototype.forEach.call(app.querySelectorAll(".verify-claim"), function (btn) {
      btn.addEventListener("click", function () {
        var c = (row.claims || [])[Number(btn.dataset.ci)];
        var el = document.getElementById("cvs-" + btn.dataset.ci);
        if (!c || !el) return;
        el.innerHTML = '<span class="vstate info checking">checking…</span>';
        fetch(verifyClaimUrl(row.passportId, c))
          .then(function (r) { return r.json(); })
          .then(function (b) {
            if (b.verified === true) {
              el.innerHTML = '<span class="vstate ok">' + checkSvg() + "proven on " + esc(b.checkedNetwork || "chain") + "</span>";
              drawCheck(el);
              flash(btn.closest(".claim"), "row-glow");
            } else if (!b.checkedNetwork) {
              el.innerHTML = '<span class="vstate info">cannot check here</span>';
            } else {
              el.innerHTML = '<span class="vstate warn">not confirmed</span>';
              flash(el, "shake");
            }
          })
          .catch(function () { el.innerHTML = '<span class="vstate err">check failed</span>'; });
      });
    });
    if (row.status === "anchored") {
      if (!canVerify) {
        showBanner("warn", "Anchored on " + row.anchorNetwork,
          "This explorer verifies against " + state.network + ", so the live check cannot run here. Use the Midnight explorer link below as proof.");
      } else {
        runVerify(); // explorer behavior: verify automatically on open
      }
    } else {
      showBanner("warn", "Not anchored yet", "Status: " + row.status + ". No on-chain anchor to verify.");
    }

    var credDl = document.getElementById("credDl");
    if (credDl) {
      credDl.addEventListener("click", function (ev) {
        ev.preventDefault();
        fetch(API + "/passportCredential(payloadHash='" + encodeURIComponent(row.payloadHash) + "')")
          .then(function (r) { return r.json(); })
          .then(function (b) {
            var blob = new Blob([b.value || JSON.stringify(b)], { type: "application/json" });
            var a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = row.passportId + ".credential.json";
            a.click();
            URL.revokeObjectURL(a.href);
          });
      });
    }

    // Detail entrance: panels drift in staggered, the QR card flips flat, and
    // the on-chain hashes "decode" character by character.
    if (A) {
      fx(".detail-grid .panel", { opacity: { from: 0, to: 1 }, y: { from: 14, to: 0 }, delay: A.stagger(90), duration: 450, ease: "outQuad" });
      fx(".qr-card", { rotateY: { from: -10, to: 0 }, duration: 800, ease: "outQuad" });
      Array.prototype.forEach.call(document.querySelectorAll(".detail-grid .kv span.mono"), function (el, idx) {
        scrambleIn(el, 150 + idx * 130);
      });
    }
  }

  // ---------- routing + search ----------

  function render() {
    if (!state.loaded) return;
    var h = decodeURIComponent(location.hash || "");
    var m = h.match(/^#\/p\/(.+)$/);
    if (m) renderDetail(m[1]);
    else renderList();
    window.scrollTo(0, 0);
  }

  document.getElementById("searchForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var q = document.getElementById("searchInput").value.trim();
    // Exact passport ID, payload hash, or attestation tx jumps to the detail
    // page; anything else filters the list.
    var hit = state.rows.find(function (r) {
      var qn = q.replace(/^0x/i, "").toLowerCase();
      return r.passportId === q ||
        (r.payloadHash && r.payloadHash.toLowerCase() === qn) ||
        (r.attestationTxHash && String(r.attestationTxHash).replace(/^0x/i, "").toLowerCase() === qn);
    });
    if (hit) {
      state.query = "";
      location.hash = "#/p/" + encodeURIComponent(hit.passportId);
      render();
      return;
    }
    state.query = q;
    state.page = 1; // a new filter starts on the newest page
    if (location.hash && location.hash !== "#/") location.hash = "#/";
    render();
  });

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest ? ev.target.closest(".copy") : null;
    if (btn && navigator.clipboard) {
      navigator.clipboard.writeText(btn.dataset.copy || "");
      btn.textContent = "✓";
      setTimeout(function () { btn.innerHTML = "&#10697;"; }, 1200);
    }
  });

  window.addEventListener("hashchange", render);
  load().then(render).catch(function (e) {
    app.innerHTML = '<div class="empty">Failed to load: ' + esc(e.message || e) + "</div>";
  });

  // Gentle live refresh: poll the feed every 30s and re-render ONLY when the
  // row set actually changed (fingerprint), and ONLY on the list view. This
  // never yanks the detail page or an in-progress verify out from under the
  // user, and it skips work while the tab is hidden.
  var POLL_MS = 30000;
  function pollTick() {
    if (!state.loaded || (document.hidden === true)) return;
    fetch(API + "/anchorExplorer()")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (b) {
        if (!b) return;
        var rows = b.value || [];
        var fp = rowsFingerprint(rows);
        if (fp === state.fingerprint) return; // nothing new; leave the DOM alone
        state.fingerprint = fp;
        state.rows = rows;
        if (!/^#\/p\//.test(location.hash || "")) {
          entranceDone = true; // silent refresh, no entrance replay
          render();
        }
      })
      .catch(function () { /* transient; try again next tick */ });
  }
  setInterval(pollTick, POLL_MS);
