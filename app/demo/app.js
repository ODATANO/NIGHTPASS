/* NIGHTPASS "Try it" demo client. Plain JS, no build step, same-origin only.
   State machine over four views (landing / form / run / done); testerId,
   profile and runId live in localStorage so a reload resumes the run. */
(() => {
  'use strict';

  const API = '/api/v1/demo';
  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k) => { try { return localStorage.getItem('nightpass-demo-' + k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem('nightpass-demo-' + k, v); } catch { /* private mode */ } },
    del: (k) => { try { localStorage.removeItem('nightpass-demo-' + k); } catch { /* ignore */ } }
  };

  async function api(method, path, body, opts) {
    const res = await fetch(API + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts && opts.signal
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = {}; }
    if (!res.ok) {
      const msg = json?.error?.message || text.slice(0, 200) || res.statusText;
      const e = new Error(msg); e.status = res.status; throw e;
    }
    return json;
  }

  function show(view) {
    for (const v of ['viewLanding', 'viewForm', 'viewRun', 'viewDone']) $(v).hidden = v !== view;
  }

  // Button loading state: spinner + progress label while a request runs.
  function setLoading(btn, label) {
    if (!btn.dataset.orig) btn.dataset.orig = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = '<span class="btn-spinner"></span>' + label;
  }
  function resetLoading(btn) {
    if (btn.dataset.orig) btn.innerHTML = btn.dataset.orig;
    btn.classList.remove('loading');
    btn.disabled = false;
  }

  // ---------- landing ----------

  // ---------- sponsor battery (landing) ----------
  // Small battery gauge next to the start button: fill = share of the
  // fee-sponsor pool that is synced ('ready'), charging animation while any
  // sponsor is still syncing. Purely informational; the start button stays
  // usable as soon as the service says enabled.
  const BATT_MAX_W = 26; // inner width of the battery body (x 3..29)

  // The start button stays disabled until BOTH the service says the demo is
  // open (budget left) AND the sponsor pool reports enough capacity. Without
  // a configured pool the battery is hidden and only the service state rules.
  let demoOpen = false;
  let sponsorReady = false;

  function updateStartButton() {
    $('btnStart').disabled = !(demoOpen && sponsorReady);
  }

  function renderSponsorBattery(pool) {
    const box = $('sponsorBattery');
    if (!Array.isArray(pool) || pool.length === 0) {
      box.hidden = true;
      sponsorReady = true; // no pool configured: don't block the button
      updateStartButton();
      return;
    }
    box.hidden = false;
    const ready = pool.filter((s) => s.state === 'ready').length;
    const warming = pool.some((s) => s.state === 'warming' || s.state === 'cold');
    const error = pool.some((s) => s.state === 'error');
    // Capacity view: full once enough sponsors for max parallelism (3) are
    // synced, even while spare pool members are still charging up.
    const needed = Math.min(3, pool.length);
    const pct = Math.min(1, ready / needed);
    const fill = $('battFill');
    const targetW = Math.round(BATT_MAX_W * Math.max(pct, warming ? 0.18 : 0));
    if (!renderSponsorBattery.animated) {
      // First paint: let the battery visibly charge up from empty instead of
      // snapping to its level (the CSS width transition does the sweep).
      renderSponsorBattery.animated = true;
      fill.setAttribute('width', '0');
      setTimeout(() => fill.setAttribute('width', String(targetW)), 500);
    } else {
      fill.setAttribute('width', String(targetW));
    }
    box.classList.toggle('ready', ready >= needed);
    box.classList.toggle('charging', warming && ready < needed);
    box.classList.toggle('error', error && ready === 0);
    const label = $('sponsorBatteryLabel');
    if (ready >= needed) label.textContent = 'dust sponsor ready';
    else if (warming) label.textContent = needed > 1 ? `dust sponsor charging… (${ready}/${needed})` : 'dust sponsor charging…';
    else if (error) label.textContent = 'dust sponsor offline';
    else label.textContent = `dust sponsor ready (${ready}/${needed})`;
    // At least one ready sponsor can carry runs (fewer in parallel, but real).
    sponsorReady = ready >= 1;
    updateStartButton();
  }

  // During the boot catch-up the wallet worker is fully busy syncing and the
  // status read times out. That is CHARGING, not offline: keep the battery in
  // its charging state instead of hiding it or claiming the sponsor is dead.
  function renderSponsorBatteryIndeterminate() {
    const box = $('sponsorBattery');
    box.hidden = false;
    box.classList.remove('ready', 'error');
    box.classList.add('charging');
    const fill = $('battFill');
    if (!renderSponsorBattery.animated) {
      renderSponsorBattery.animated = true;
      fill.setAttribute('width', '0');
    }
    const cur = Number(fill.getAttribute('width') || 0);
    const min = Math.round(BATT_MAX_W * 0.18);
    setTimeout(() => fill.setAttribute('width', String(Math.max(cur, min))), cur ? 0 : 500);
    $('sponsorBatteryLabel').textContent = 'dust sponsor charging…';
    sponsorReady = false;
    updateStartButton();
  }

  async function pollSponsorBattery() {
    if ($('viewLanding').hidden) return;
    try {
      const res = await api('GET', '/demoSponsorStatus()', undefined, { signal: AbortSignal.timeout(10000) });
      renderSponsorBattery(Array.isArray(res) ? res : res.value);
    } catch (e) {
      // A real HTTP error (404 on an old server) hides the widget; a network
      // failure or timeout is indeterminate = keep charging.
      if (e && e.status) $('sponsorBattery').hidden = true;
      else renderSponsorBatteryIndeterminate();
    }
  }

  let batteryTimer = null;

  async function initLanding() {
    show('viewLanding');
    void pollSponsorBattery();
    if (!batteryTimer) batteryTimer = setInterval(pollSponsorBattery, 12000);
    try {
      const info = await api('GET', '/demoInfo()');
      if (!info.enabled) {
        demoOpen = false;
        updateStartButton();
        $('landingInfo').textContent = 'The demo is currently closed. Try again later.';
        return;
      }
      const running = info.runningCount ?? info.queueDepth ?? 0;
      const waiting = info.waitingCount ?? 0;
      const busy = running || waiting
        ? `${running} passport${running === 1 ? '' : 's'} being anchored now${waiting ? `, ${waiting} waiting` : ''}. `
        : '';
      $('landingInfo').textContent = `${busy}${info.dailyRemaining} demo passports left today.`;
      demoOpen = info.dailyRemaining > 0;
      updateStartButton();
      if (info.dailyRemaining <= 0) {
        $('landingInfo').textContent = 'Today’s on-chain budget is used up. Come back tomorrow.';
      }
    } catch {
      $('landingInfo').textContent = 'Could not reach the demo service.';
      $('btnStart').disabled = true;
    }
  }

  $('btnStart').addEventListener('click', async () => {
    // A cancelled (parked) identity is reused instead of minting a new one:
    // startTester counts against the per-IP daily budget, so cancel + start
    // must not burn a slot.
    if (store.get('testerId') && store.get('night')) {
      store.del('parked');
      enterForm();
      return;
    }
    setLoading($('btnStart'), 'Creating your identity wallet…');
    try {
      const t = await api('POST', '/startTester', {});
      store.set('testerId', t.testerId);
      store.set('night', t.nightAddress);
      store.set('shielded', t.shieldedAddress);
      resetLoading($('btnStart'));
      enterForm();
    } catch (e) {
      $('landingInfo').textContent = e.message;
      resetLoading($('btnStart'));
    }
  });

  // ---------- form ----------

  // The product families (demoProfiles) and their claim catalogues
  // (demoClaimFields) come from the server, so fields, bounds and claim
  // directions are defined in exactly one place.
  var profiles = [];
  var profile = null;      // the chosen family
  var primarySpec = null;  // its always-proven claim
  var claimSpecs = [];     // its optional claims (the cart)

  /** Escape for every place this app builds markup from server data. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function loadProfiles() {
    if (profiles.length) return profiles;
    var res = await api('GET', '/demoProfiles()');
    profiles = (res.value || res || []).map(function (p) {
      var head = [];
      try { head = JSON.parse(p.headJson || '[]'); } catch (e) { head = []; }
      return {
        id: p.id, label: p.label, tagline: p.tagline, regulation: p.regulation,
        primaryField: p.primaryField, secondLife: !!p.secondLife, head: head
      };
    });
    return profiles;
  }

  /** "battery" or "component": the family word for sentences, from its label. */
  function familyNoun(label) {
    return String(label || 'product').replace(/ passport$/i, '').toLowerCase();
  }

  function renderFamilyTiles() {
    var box = $('familyTiles');
    box.innerHTML = '';
    profiles.forEach(function (p) {
      var on = !!profile && profile.id === p.id;
      var tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'family-tile' + (on ? ' selected' : '');
      tile.setAttribute('role', 'radio');
      tile.setAttribute('aria-checked', on ? 'true' : 'false');
      tile.dataset.profile = p.id;
      tile.innerHTML =
        '<span class="ft-label">' + esc(p.label) + '</span>' +
        '<span class="ft-tagline">' + esc(p.tagline) + '</span>' +
        '<span class="ft-reg">' + esc(p.regulation) + '</span>';
      tile.addEventListener('click', function () { void selectProfile(p.id); });
      box.appendChild(tile);
    });
  }

  async function selectProfile(id) {
    profile = profiles.find(function (p) { return p.id === id; }) || profiles[0];
    if (!profile) return;
    store.set('profile', profile.id);
    store.set('profileLabel', profile.label);
    renderFamilyTiles();
    $('formTitle').textContent = 'Your ' + profile.label.toLowerCase();
    renderHeadFields(profile.head);
    $('secondLifeBlock').hidden = !profile.secondLife;
    $('fSecondLife').checked = false;
    await loadClaimFields(profile.id);
  }

  function headInput(f) {
    var el;
    if (f.kind === 'select') {
      el = document.createElement('select');
      (f.options || []).forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o; opt.textContent = o;
        opt.selected = String(o) === String(f.defaultValue);
        el.appendChild(opt);
      });
    } else {
      el = document.createElement('input');
      if (f.kind === 'number') {
        el.type = 'number'; el.step = 'any';
        if (f.min != null) el.min = String(f.min);
        if (f.max != null) el.max = String(f.max);
      } else {
        // Head text becomes public explorer content; the catalog carries the charset the server accepts.
        if (f.maxLength != null) el.maxLength = f.maxLength;
        if (f.pattern) el.pattern = f.pattern;
      }
      el.value = f.defaultValue == null ? '' : String(f.defaultValue);
    }
    el.id = 'fHead-' + f.name;
    el.required = true;
    return el;
  }

  function renderHeadFields(head) {
    var box = $('headFields');
    box.innerHTML = '';
    head.forEach(function (f) {
      var label = document.createElement('label');
      label.appendChild(document.createTextNode(f.label));
      label.appendChild(headInput(f));
      if (f.hint) {
        var hint = document.createElement('span');
        hint.className = 'hint'; hint.textContent = f.hint;
        label.appendChild(hint);
      }
      box.appendChild(label);
    });
  }

  /** The head values as createDemoPassport expects them in headJson. */
  function headValues() {
    var out = {};
    (profile ? profile.head : []).forEach(function (f) {
      var el = $('fHead-' + f.name);
      if (!el) return;
      out[f.name] = f.kind === 'number' ? Number(el.value) : el.value.trim();
    });
    return out;
  }

  async function enterForm() {
    $('idNight').textContent = store.get('night') || '';
    $('familyError').textContent = '';
    show('viewForm');
    try {
      await loadProfiles();
    } catch (e) {
      $('familyError').textContent = 'Could not load the product families: ' + e.message;
      $('btnCreate').disabled = true;
      return;
    }
    await selectProfile(profile ? profile.id : (store.get('profile') || (profiles[0] && profiles[0].id)));
  }

  // ---- primary claim (always proven) ------------------------------------

  function relWord(spec) { return spec.predicate === 'lessOrEqual' ? 'at most' : 'at least'; }

  function holds(spec, value, threshold) {
    return spec.predicate === 'lessOrEqual' ? value <= threshold : value >= threshold;
  }

  function renderPrimary(spec) {
    primarySpec = spec;
    $('primaryValueLabel').textContent = spec.label + ' (' + spec.unit + ')';
    $('primaryThresholdLabel').textContent =
      'Prove publicly: ' + spec.label.toLowerCase() + ' is ' + relWord(spec) + ' (' + spec.unit + ')';
    var v = $('fPrimaryValue'), t = $('fPrimaryThreshold');
    v.min = String(spec.min); v.max = String(spec.max); v.value = String(spec.defaultValue);
    t.min = String(spec.min); t.max = String(spec.max * 2); t.value = String(spec.defaultThreshold);
    syncClaimBounds(false);
  }

  // Keep the primary pair valid while typing: the public bound can never sit
  // on the wrong side of the confidential value (the proof must be TRUE).
  function syncClaimBounds(bump) {
    if (!primarySpec) return;
    var v = Number($('fPrimaryValue').value), t = $('fPrimaryThreshold');
    if (!Number.isFinite(v)) return;
    if (primarySpec.predicate === 'lessOrEqual') {
      t.min = String(Math.max(primarySpec.min, v));
      t.max = String(primarySpec.max * 2);
      if (bump && Number(t.value) < v) t.value = String(v);
    } else {
      t.min = String(primarySpec.min);
      t.max = String(v);
      if (bump && Number(t.value) > v) t.value = String(v);
    }
  }
  $('fPrimaryValue').addEventListener('input', () => syncClaimBounds(false));
  $('fPrimaryValue').addEventListener('change', () => syncClaimBounds(true));
  $('fPrimaryThreshold').addEventListener('change', () => syncClaimBounds(true));

  // ---- extra claims ------------------------------------------------------
  // Each entry is opt-in: tick it, set a confidential value and the public bound.

  function claimRow(spec) {
    var wrap = document.createElement('label');
    wrap.className = 'claim-item';
    var idBase = 'claim_' + spec.field;
    if (spec.kind === 'membership') {
      // Membership claim: pick the confidential value from the published
      // allow-list; the proof shows it IS in the list, never which one.
      var options = [];
      try { options = JSON.parse(spec.optionsJson || '[]'); } catch (e) { options = []; }
      wrap.innerHTML =
        '<span class="claim-line">' +
          '<input type="checkbox" id="' + idBase + '_on" data-field="' + esc(spec.field) + '">' +
          '<span class="claim-label">' + esc(spec.label) + '</span>' +
          '<span class="chip-conf">confidential</span>' +
          '<span class="claim-inputs">' +
            '<span class="claim-input">Value' +
              '<select id="' + idBase + '_c" disabled>' +
                options.map(function (o) {
                  return '<option value="' + esc(o) + '"' + (o === spec.defaultOption ? ' selected' : '') + '>' + esc(o) + '</option>';
                }).join('') +
              '</select>' +
            '</span>' +
            '<span class="claim-input">Prove: one of ' + options.length + ' ' + esc(spec.setLabel || 'allowed values').toLowerCase() + '</span>' +
          '</span>' +
        '</span>' +
        // Membership is a different kind of claim than the bounds above, so
        // it gets a permanent explanation plus the public list it refers to.
        '<span class="hint claim-explain">Proves your ' + esc(spec.label).toLowerCase() + ' is on this public list. Which of the ' + options.length +
          ' it is stays hidden. ' +
          '<button type="button" class="link-btn" id="' + idBase + '_toggle">Show the list</button></span>' +
        '<span class="claim-set-list" id="' + idBase + '_list" hidden>' + options.map(esc).join(' \u00b7 ') + '</span>' +
        '<span class="hint claim-hint"></span>';
      var mbox = wrap.querySelector('#' + idBase + '_on');
      mbox.addEventListener('change', function () {
        wrap.classList.toggle('on', mbox.checked);
        wrap.querySelector('#' + idBase + '_c').disabled = !mbox.checked;
        updateClaimState();
      });
      wrap.querySelector('#' + idBase + '_c').addEventListener('change', updateClaimState);
      var toggle = wrap.querySelector('#' + idBase + '_toggle');
      var list = wrap.querySelector('#' + idBase + '_list');
      toggle.addEventListener('click', function (ev) {
        ev.preventDefault();
        list.hidden = !list.hidden;
        toggle.textContent = list.hidden ? 'Show the list' : 'Hide the list';
      });
      return wrap;
    }
    var rel = spec.predicate === 'lessOrEqual' ? 'at most' : 'at least';
    wrap.innerHTML =
      '<span class="claim-line">' +
        '<input type="checkbox" id="' + idBase + '_on" data-field="' + esc(spec.field) + '">' +
        '<span class="claim-label">' + esc(spec.label) + '</span>' +
        '<span class="chip-conf">confidential</span>' +
        '<span class="claim-inputs">' +
          '<span class="claim-input">Value (' + esc(spec.unit) + ')' +
            '<input type="number" id="' + idBase + '_v" min="' + spec.min + '" max="' + spec.max +
              '" step="1" value="' + spec.defaultValue + '" disabled>' +
          '</span>' +
          '<span class="claim-input">Prove: ' + rel +
            '<input type="number" id="' + idBase + '_t" min="' + spec.min + '" max="' + (spec.max * 2) +
              '" step="1" value="' + spec.defaultThreshold + '" disabled>' +
          '</span>' +
        '</span>' +
      '</span>' +
      '<span class="hint claim-hint"></span>';
    var box = wrap.querySelector('#' + idBase + '_on');
    box.addEventListener('change', function () {
      wrap.classList.toggle('on', box.checked);
      wrap.querySelectorAll('.claim-inputs input').forEach(function (i) { i.disabled = !box.checked; });
      updateClaimState();
    });
    wrap.querySelector('#' + idBase + '_v').addEventListener('input', updateClaimState);
    wrap.querySelector('#' + idBase + '_t').addEventListener('input', updateClaimState);
    return wrap;
  }

  /** The claims the visitor ticked, with their spec attached. */
  function selectedClaims() {
    var out = [];
    claimSpecs.forEach(function (spec) {
      var on = $('claim_' + spec.field + '_on');
      if (!on || !on.checked) return;
      if (spec.kind === 'membership') {
        out.push({ spec: spec, field: spec.field, member: $('claim_' + spec.field + '_c').value });
        return;
      }
      out.push({
        spec: spec,
        field: spec.field,
        value: Number($('claim_' + spec.field + '_v').value),
        threshold: Number($('claim_' + spec.field + '_t').value)
      });
    });
    return out;
  }

  function claimTrue(c) {
    if (c.spec.kind === 'membership') { return !!c.member; } // options ARE the list
    return holds(c.spec, c.value, c.threshold);
  }

  /** Live count plus a per-row warning when a claim would not hold. */
  function updateClaimState() {
    var picked = selectedClaims();
    var n = picked.length + 1; // the primary claim is always proven
    $('claimCount').textContent = n === 1 ? '1 claim' : n + ' claims, one transaction';
    claimSpecs.forEach(function (spec) {
      var row = $('claim_' + spec.field + '_on');
      if (!row) return;
      var hint = row.closest('.claim-item').querySelector('.claim-hint');
      var c = picked.find(function (p) { return p.field === spec.field; });
      if (!c) { hint.textContent = ''; hint.classList.remove('err'); return; }
      if (spec.kind === 'membership') { hint.textContent = ''; hint.classList.remove('err'); return; }
      var rel = spec.predicate === 'lessOrEqual' ? 'at most' : 'at least';
      if (claimTrue(c)) {
        // No informational hint: ticked rows stay one line. Only an untrue
        // claim gets an inline explanation (it blocks submit).
        hint.textContent = '';
        hint.classList.remove('err');
      } else {
        hint.textContent = 'This claim is not true, so it cannot be proven: ' + c.value + ' is not ' + rel + ' ' + c.threshold + '.';
        hint.classList.add('err');
      }
    });
  }

  // A later family pick wins over a slower earlier catalogue response.
  var claimLoadSeq = 0;

  async function loadClaimFields(profileId) {
    var seq = ++claimLoadSeq;
    var all = [];
    try {
      var res = await api('GET', "/demoClaimFields(profile='" + encodeURIComponent(profileId) + "')");
      all = res.value || res || [];
    } catch (e) {
      $('familyError').textContent = 'Could not load the claim catalogue: ' + e.message;
    }
    if (seq !== claimLoadSeq) return;
    var primary = all.find(function (c) { return c.primary; })
      || all.find(function (c) { return profile && c.field === profile.primaryField; });
    claimSpecs = all.filter(function (c) { return c !== primary; });
    if (primary) renderPrimary(primary); else primarySpec = null;
    $('btnCreate').disabled = !primary;
    var list = $('claimList');
    list.innerHTML = '';
    $('claimCart').hidden = !claimSpecs.length;
    claimSpecs.forEach(function (spec) { list.appendChild(claimRow(spec)); });
    updateClaimState();
  }

  $('passportForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('formError').textContent = '';
    if (!profile || !primarySpec) {
      $('formError').textContent = 'Pick a product family first.';
      return;
    }
    const pv = Number($('fPrimaryValue').value), pt = Number($('fPrimaryThreshold').value);
    if (!holds(primarySpec, pv, pt)) {
      $('formError').textContent = primarySpec.label + ': ' + pv + ' is not ' + relWord(primarySpec) + ' ' + pt
        + '. The demo proves a TRUE claim; adjust the value or the bound.';
      return;
    }
    const extra = selectedClaims();
    const untrue = extra.find(function (c) { return !claimTrue(c); });
    if (untrue) {
      $('formError').textContent = untrue.spec.label + ': that claim is not true, so it cannot be proven. '
        + 'Adjust the value or the bound.';
      return;
    }
    const claims = [{ field: primarySpec.field, value: pv, threshold: pt }].concat(extra.map(function (c) {
      return c.spec.kind === 'membership'
        ? { field: c.field, member: c.member }
        : { field: c.field, value: c.value, threshold: c.threshold };
    }));
    setLoading($('btnCreate'), 'Submitting your passport…');
    try {
      const r = await api('POST', '/createDemoPassport', {
        testerId: store.get('testerId'),
        profile: profile.id,
        headJson: JSON.stringify(headValues()),
        claimsJson: JSON.stringify(claims),
        secondLife: !!(profile.secondLife && $('fSecondLife').checked)
      });
      store.set('runId', r.runId);
      store.set('passportId', r.passportId);
      resetLoading($('btnCreate'));
      enterRun();
    } catch (e) {
      // 404 = the parked identity no longer exists server-side (disposable
      // demo DB was wiped). Reset to a fresh start instead of a dead end.
      if (e && e.status === 404) {
        restart();
        return;
      }
      $('formError').textContent = e.message;
      resetLoading($('btnCreate'));
    }
  });

  // Cancel before anything went on-chain: back to the landing page. The
  // identity is parked locally (not deleted) so a later start reuses it.
  $('btnCancelForm').addEventListener('click', () => {
    if ($('btnCreate').classList.contains('loading')) return;
    store.set('parked', '1');
    $('formError').textContent = '';
    void initLanding();
  });

  // ---------- run ----------

  let pollTimer = null;

  function enterRun() {
    $('runPassportId').textContent = store.get('passportId') || '';
    $('runError').hidden = true;
    $('btnRestartRun').hidden = true;
    lastRendered = '';
    show('viewRun');
    poll();
    pollTimer = setInterval(poll, 4000);
  }


  // Honest waiting label: with a leased slot only the start stagger ticks
  // (countdown), otherwise the run really waits for a free slot. Countdown is
  // rounded to 5s so the timeline is not rebuilt on every poll tick.
  function waitingText(st) {
    if (typeof st.runningCount !== 'number') {
      return st.queuePosition > 0 ? `waiting (queue position ${st.queuePosition})` : 'pending';
    }
    const running = st.runningCount ? `${st.runningCount} running` : '';
    if (st.startingInSec >= 0) {
      const sec = Math.max(5, Math.ceil(st.startingInSec / 5) * 5);
      return running ? `${running}, starting yours in ~${sec}s` : `starting in ~${sec}s`;
    }
    const ahead = st.waitingAhead > 0 ? `, ${st.waitingAhead} ahead of you` : '';
    return `waiting for a free slot (${running || 'busy'}${ahead})`;
  }

  // The anchor is ONE Midnight transaction (see srv/lib/anchor-plan.ts):
  // attest, anchorContentRoot and bindDocument together. The timeline shows
  // the three circuits as one grouped entry. Multi-claim proofs (kind
  // "prove:<field>") stay a single batched transaction and get the same
  // grouped treatment.
  const BATCH_KINDS = ['attest', 'anchorContentRoot', 'bindDocument'];
  const isProveKind = (k) => String(k || '').indexOf('prove:') === 0;

  const ANCHOR_GROUP = {
    title: 'Anchor fingerprint, field root and passport id',
    badge: (n) => n + ' circuits · 1 transaction',
    info: 'The fingerprint is attested, the salted field tree root is anchored and the passport id is bound to it, all in one transaction.',
    txLabel: 'tx '
  };
  const PROVE_GROUP = {
    title: 'ZK-prove your claims',
    badge: (n) => n + ' ZK proofs · 1 batched transaction',
    info: 'Every line below is a public statement about one of your confidential values, and that statement is all the proof reveals. ' +
      'The real number, or which entry of a public list your value is, never appears anywhere: on-chain sits only the evidence that the statement holds.',
    txLabel: 'proof tx '
  };

  // Right-side status area: a drawn checkmark when done, text otherwise. The
  // check replaces the word so finished rows read at a glance.
  function stateNode(status, waitLabel) {
    const state = document.createElement('span');
    state.className = 'step-state';
    if (status === 'succeeded') {
      state.innerHTML = '<svg class="step-check" viewBox="0 0 16 16" aria-label="done" role="img">'
        + '<path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    } else {
      state.textContent = waitLabel || status;
    }
    return state;
  }

  // Every step reserves its tx line from the start so the timeline never
  // shifts down when a hash lands mid-run; the link just fills in.
  function txNode(s, prefix) {
    const tx = document.createElement('div');
    tx.className = 'step-tx';
    if (s && s.txHash) {
      const a = document.createElement('a');
      a.href = s.explorerUrl || '#'; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = (prefix || 'tx ') + s.txHash.slice(0, 20) + '…';
      tx.append(a);
    }
    return tx;
  }

  function groupStatus(subs) {
    if (subs.some((s) => s.status === 'failed')) return 'failed';
    if (subs.some((s) => s.status === 'running')) return 'running';
    if (subs.every((s) => s.status === 'succeeded')) return 'succeeded';
    if (subs.some((s) => s.status === 'succeeded')) return 'running';
    return 'pending';
  }

  function renderBatchGroup(subs, st, opts) {
    const li = document.createElement('li');
    const status = groupStatus(subs);
    li.className = status + ' batch-group';
    const dot = document.createElement('span'); dot.className = 'step-dot';
    const main = document.createElement('span'); main.className = 'step-main';
    const label = document.createElement('span'); label.className = 'step-label';
    label.textContent = opts.title;
    const badge = document.createElement('span'); badge.className = 'batch-badge';
    badge.textContent = opts.badge(subs.length);
    const state = stateNode(status,
      status === 'pending' && st && st.state === 'queued' ? waitingText(st) : '');
    const head = document.createElement('div'); head.className = 'step-head';
    head.append(label, badge, state);
    main.append(head);
    if (opts.info) {
      const info = document.createElement('div');
      info.className = 'step-info';
      info.textContent = opts.info;
      main.append(info);
    }

    const sub = document.createElement('ul'); sub.className = 'batch-sub';
    for (const s of subs) {
      const item = document.createElement('li');
      item.className = s.status;
      const sdot = document.createElement('span'); sdot.className = 'step-dot sub-dot';
      const slabel = document.createElement('span'); slabel.textContent = s.label || s.kind;
      item.append(sdot, slabel);
      sub.append(item);
    }
    main.append(sub);

    // One shared tx link on a line reserved from the start; per-substep links
    // only if the server ever anchors in separate transactions (older plugin
    // fallback).
    const txs = [...new Set(subs.filter((s) => s.txHash).map((s) => s.txHash))];
    if (txs.length > 1) {
      for (const s of subs.filter((x) => x.txHash)) {
        main.append(txNode(s, (s.label || s.kind) + ': tx '));
      }
    } else {
      main.append(txNode(subs.find((x) => x.txHash), opts.txLabel));
    }
    li.append(dot, main);
    return li;
  }

  function renderSteps(steps, st) {
    const ol = $('timeline');
    ol.innerHTML = '';
    let batchSubs = null;
    let proveSubs = null;
    for (const s of steps) {
      if (BATCH_KINDS.includes(s.kind)) {
        if (!batchSubs) {
          batchSubs = steps.filter((x) => BATCH_KINDS.includes(x.kind));
          ol.append(renderBatchGroup(batchSubs, st, ANCHOR_GROUP));
        }
        continue; // rendered inside the group
      }
      if (isProveKind(s.kind)) {
        if (!proveSubs) {
          proveSubs = steps.filter((x) => isProveKind(x.kind));
          ol.append(renderBatchGroup(proveSubs, st, PROVE_GROUP));
        }
        continue; // rendered inside the group
      }
      const li = document.createElement('li');
      li.className = s.status;
      const dot = document.createElement('span'); dot.className = 'step-dot';
      const main = document.createElement('span'); main.className = 'step-main';
      const label = document.createElement('span'); label.className = 'step-label'; label.textContent = s.label || s.kind;
      const state = stateNode(s.status,
        s.status === 'pending' && st && st.state === 'queued' ? waitingText(st) : '');
      // Single steps stay ONE line: the tx link (if any) sits inline on the
      // right next to the check instead of expanding the tile.
      const head = document.createElement('div'); head.className = 'step-head slim';
      head.append(label);
      if (s.txHash) {
        const tx = document.createElement('span'); tx.className = 'step-tx-inline';
        const a = document.createElement('a');
        a.href = s.explorerUrl || '#'; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = 'tx ' + s.txHash.slice(0, 12) + '…';
        tx.append(a);
        head.append(tx);
      }
      head.append(state);
      main.append(head);
      li.append(dot, main);
      ol.append(li);
    }
  }

  let lastRendered = '';

  async function poll() {
    try {
      const runId = store.get('runId');
      if (!runId) return;
      const st = await api('GET', `/demoRunStatus(runId=${runId})`);
      let steps = [];
      try { steps = JSON.parse(st.stepsJson || '[]'); } catch { /* keep empty */ }
      // Skip the DOM rebuild when nothing changed: a queued visitor would
      // otherwise get a full timeline teardown every 4s (GC churn, killed
      // text selections and mid-click links).
      const waitLabel = st.state === 'queued' ? waitingText(st) : '';
      const fingerprint = st.stepsJson + '|' + waitLabel + '|' + st.state;
      if (fingerprint !== lastRendered) {
        lastRendered = fingerprint;
        renderSteps(steps, st);
      }
      if (st.state === 'done') {
        clearInterval(pollTimer);
        enterDone(steps);
      } else if (st.state === 'failed') {
        clearInterval(pollTimer);
        $('runError').hidden = false;
        $('runError').textContent = 'This run failed: ' + (st.error || 'unknown error') +
          '. Your daily budget was still used; sorry about that.';
        $('btnRestartRun').hidden = false;
      }
    } catch (e) {
      // 404 = the run row no longer exists (disposable demo DB was wiped, or
      // the instance was rebuilt). Without this branch the page would poll an
      // empty timeline forever; reset to a fresh start instead.
      if (e && e.status === 404) {
        restart();
        return;
      }
      /* transient poll error: keep trying */
    }
  }

  // ---------- done ----------

  function enterDone(steps) {
    const pid = store.get('passportId') || '';
    $('donePassportId').textContent = pid;
    const links = [];
    const published = steps.some((s) => s.kind === 'publish' && s.status === 'succeeded');
    // The QR encodes the passport's public /p/<id> link: the published one on
    // zkpassport.eu, or this instance's own resolver when publish was skipped
    // (local dev). A load error just keeps the block hidden.
    const qrImg = $('doneQrImg');
    if (qrImg && pid) {
      const qrHost = published ? 'https://zkpassport.eu' : '';
      qrImg.onload = () => { $('doneQr').hidden = false; };
      qrImg.onerror = () => { $('doneQr').hidden = true; };
      qrImg.src = `${qrHost}/qr/${encodeURIComponent(pid)}.png`;
    }
    if (published) {
      links.push(`<a href="https://zkpassport.eu/p/${encodeURIComponent(pid)}" target="_blank" rel="noopener">View it on the public explorer (zkpassport.eu)</a>`);
    }
    // No separate link to this instance's explorer: the QR IS the passport
    // link (public explorer when published, local resolver otherwise).
    const proof = steps.find((s) => (s.kind === 'provePredicate' || isProveKind(s.kind)) && s.txHash);
    if (proof) {
      links.push(`<a href="${proof.explorerUrl}" target="_blank" rel="noopener">View the proof predicate transaction on the Midnight explorer</a>`);
    }
    const secondLife = steps.find((s) => s.kind === 'secondLife' && s.status === 'succeeded');
    if (secondLife) {
      links.push('<span class="hint">Your ' + esc(familyNoun(store.get('profileLabel'))) + ' lived a second life: it aged, was repurposed and re-anchored as version 2. The explorer page shows its full anchor history; version 1 stays verifiable forever.</span>');
    }
    $('doneLinks').innerHTML = links.join('') || '';
    // The proven statements, as they were shown in the timeline: the public
    // side of every confidential value.
    const proven = steps.filter((s) => (s.kind === 'provePredicate' || isProveKind(s.kind)) && s.status === 'succeeded');
    const list = $('doneClaimList');
    list.innerHTML = '';
    for (const s of proven) {
      const li = document.createElement('li');
      li.textContent = String(s.label || s.kind).replace(/^ZK-prove /, '');
      list.append(li);
    }
    $('doneClaims').hidden = proven.length === 0;
    show('viewDone');
  }

  // ---------- start over ----------

  function restart() {
    clearInterval(pollTimer);
    for (const k of ['testerId', 'night', 'shielded', 'runId', 'passportId', 'parked', 'profile', 'profileLabel']) store.del(k);
    profile = null;
    $('btnStart').disabled = false;
    $('btnCreate').disabled = false;
    void initLanding();
  }
  $('btnRestart').addEventListener('click', restart);
  $('btnRestartRun').addEventListener('click', restart);

  $('btnCopyId').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(store.get('passportId') || '');
      $('btnCopyId').textContent = 'Copied';
      setTimeout(() => { $('btnCopyId').textContent = 'Copy'; }, 1500);
    } catch { /* clipboard unavailable (http origin): ignore */ }
  });

  // ---------- boot: resume where the visitor left off ----------

  if (store.get('runId')) enterRun();
  else if (store.get('testerId') && !store.get('parked')) void enterForm();
  else void initLanding();
})();
