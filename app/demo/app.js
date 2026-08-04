/* NIGHTPASS "Try it" demo client. Plain JS, no build step, same-origin only.
   State machine over four views (landing / form / run / done); testerId and
   runId live in localStorage so a reload resumes the run. */
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

  // Pre-fill the form with a plausible random battery so visitors can go
  // straight to anchoring. Only fills the empty text fields (a returning
  // visitor's own edits stay untouched); numbers are re-rolled each time.
  const RAND_MODEL_A = ['Volt', 'Ion', 'Nova', 'Flux', 'Amp', 'Watt', 'Zap', 'Core', 'Polar', 'Titan'];
  const RAND_MODEL_B = ['Cell', 'Pack', 'Drive', 'Grid', 'Store'];
  const RAND_MODEL_C = ['EV-60', 'EV-75', 'EV-90', 'X-120', 'S-45', 'Max-80', 'Ultra-100', 'Go-55'];
  const RAND_WERK = ['DemoWorks', 'NordCell', 'VoltFab', 'PowerHaus', 'CellSmith', 'ElectroWerk', 'GigaZelle', 'BatterieWerk', 'RheinVolt', 'HansaCell'];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  function randomizeForm() {
    if (!$('fModel').value) $('fModel').value = `${pick(RAND_MODEL_A)}${pick(RAND_MODEL_B)} ${pick(RAND_MODEL_C)}`;
    if (!$('fManufacturer').value) $('fManufacturer').value = pick(RAND_WERK);
    $('fWeight').value = String(250 + 10 * Math.floor(Math.random() * 40));
    $('fPerf').value = pick(['A', 'B', 'B', 'C', 'C', 'D']);
    const co2 = 2800 + 50 * Math.floor(Math.random() * 36);
    $('fCo2').value = String(co2);
    $('fThreshold').value = String(Math.ceil((co2 * 1.05) / 100) * 100);
    syncClaimBounds(false);
  }

  function enterForm() {
    $('idNight').textContent = store.get('night') || '';
    $('idShielded').textContent = store.get('shielded') || '';
    randomizeForm();
    show('viewForm');
  }

  // Keep the claim pair valid while typing: the public threshold can never be
  // below the confidential CO2 value (the proof must be TRUE). The threshold
  // field's min follows the CO2 input, and both ends clamp on change.
  function syncClaimBounds(bump) {
    const co2 = Number($('fCo2').value);
    if (!Number.isFinite(co2) || co2 < 1) return;
    $('fThreshold').min = String(co2);
    if (bump && Number($('fThreshold').value) < co2) $('fThreshold').value = String(co2);
  }
  $('fCo2').addEventListener('input', () => syncClaimBounds(false));
  $('fCo2').addEventListener('change', () => syncClaimBounds(true));
  $('fThreshold').addEventListener('change', () => syncClaimBounds(true));
  syncClaimBounds(false);

  // ---- extra claims ------------------------------------------------------
  // The catalogue comes from the server (demoClaimFields) so the fields, their
  // bounds and their direction are defined in exactly one place. Each entry is
  // opt-in: tick it, set a confidential value and the public bound.

  var claimSpecs = [];

  /**
   * Escape for the one place this app builds markup from server data. The
   * catalogue is our own static list, but a template that interpolates without
   * escaping is a habit that outlives the data it was written for.
   */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function claimRow(spec) {
    var wrap = document.createElement('label');
    wrap.className = 'claim-item';
    var rel = spec.predicate === 'lessOrEqual' ? 'at most' : 'at least';
    var idBase = 'claim_' + spec.field;
    wrap.innerHTML =
      '<span class="claim-line">' +
        '<input type="checkbox" id="' + idBase + '_on" data-field="' + esc(spec.field) + '">' +
        '<span class="claim-label">' + esc(spec.label) + '</span>' +
        '<span class="chip-conf">confidential</span>' +
      '</span>' +
      '<span class="claim-inputs" hidden>' +
        '<span class="claim-input">Value (' + esc(spec.unit) + ')' +
          '<input type="number" id="' + idBase + '_v" min="' + spec.min + '" max="' + spec.max +
            '" step="1" value="' + spec.defaultValue + '">' +
        '</span>' +
        '<span class="claim-input">Prove: ' + rel +
          '<input type="number" id="' + idBase + '_t" min="' + spec.min + '" max="' + (spec.max * 2) +
            '" step="1" value="' + spec.defaultThreshold + '">' +
        '</span>' +
      '</span>' +
      '<span class="hint claim-hint"></span>';
    var box = wrap.querySelector('#' + idBase + '_on');
    var inputs = wrap.querySelector('.claim-inputs');
    box.addEventListener('change', function () {
      inputs.hidden = !box.checked;
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
    return c.spec.predicate === 'lessOrEqual' ? c.value <= c.threshold : c.value >= c.threshold;
  }

  /** Live count plus a per-row warning when a claim would not hold. */
  function updateClaimState() {
    var picked = selectedClaims();
    var n = picked.length + 1; // the footprint claim is always proven
    $('claimCount').textContent = n === 1 ? '1 claim' : n + ' claims, one transaction';
    claimSpecs.forEach(function (spec) {
      var row = $('claim_' + spec.field + '_on');
      if (!row) return;
      var hint = row.closest('.claim-item').querySelector('.claim-hint');
      var c = picked.find(function (p) { return p.field === spec.field; });
      if (!c) { hint.textContent = ''; hint.classList.remove('err'); return; }
      var rel = spec.predicate === 'lessOrEqual' ? 'at most' : 'at least';
      if (claimTrue(c)) {
        hint.textContent = 'Public: ' + spec.label.toLowerCase() + ' is ' + rel + ' ' + c.threshold + ' ' + spec.unit +
          '. The real value stays hidden.';
        hint.classList.remove('err');
      } else {
        hint.textContent = 'This claim is not true, so it cannot be proven: ' + c.value + ' is not ' + rel + ' ' + c.threshold + '.';
        hint.classList.add('err');
      }
    });
  }

  async function loadClaimFields() {
    try {
      var all = await api('GET', '/demoClaimFields()');
      claimSpecs = (all.value || all || []).filter(function (c) { return !c.primary; });
    } catch (e) {
      claimSpecs = []; // older server: the demo still runs with the single claim
    }
    var list = $('claimList');
    if (!list) return;
    list.innerHTML = '';
    if (!claimSpecs.length) { $('claimCart').hidden = true; return; }
    claimSpecs.forEach(function (spec) { list.appendChild(claimRow(spec)); });
    updateClaimState();
  }
  loadClaimFields();

  $('passportForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('formError').textContent = '';
    const co2 = Number($('fCo2').value), thr = Number($('fThreshold').value);
    if (co2 > thr) {
      $('formError').textContent = 'The threshold must be at least the CO2 value: the demo proves a TRUE claim.';
      return;
    }
    const extra = selectedClaims();
    const untrue = extra.find(function (c) { return !claimTrue(c); });
    if (untrue) {
      $('formError').textContent = untrue.spec.label + ': that claim is not true, so it cannot be proven. '
        + 'Adjust the value or the bound.';
      return;
    }
    setLoading($('btnCreate'), 'Submitting your passport…');
    try {
      const r = await api('POST', '/createDemoPassport', {
        testerId: store.get('testerId'),
        model: $('fModel').value.trim(),
        manufacturer: $('fManufacturer').value.trim(),
        weightKg: Number($('fWeight').value),
        performanceClass: $('fPerf').value,
        co2Kg: co2,
        proveThreshold: thr,
        secondLife: $('fSecondLife').checked,
        claimsJson: JSON.stringify(extra.map(function (c) {
          return { field: c.field, value: c.value, threshold: c.threshold };
        }))
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

  // One-line explanation per timeline step, shown under the label.
  const STEP_INFO = {
    sync: 'Creates your producer identity and connects it to Midnight. The passport is issued under it.',
    registerPassport: 'The registrar locks your passport id to YOUR identity on-chain, before anything else happens. Nobody else can ever claim or re-bind this id.',
    attest: 'Writes a fingerprint (hash) of your passport data to the blockchain. The data itself stays off-chain.',
    bindPassport: 'Links your passport id (hashed with blake2b-256) to that fingerprint on-chain, so anyone can look the passport up later.',
    anchorContentRoot: 'Anchors a Merkle root over the passport fields. This is what single values can be proven against.',
    provePredicate: 'Proves your CO2 claim in zero-knowledge: the chain verifies it without ever seeing the number.',
    publish: 'Puts the passport’s public data on the explorer, together with the proven claim.'
  };

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

  // The three anchor circuits ride in ONE batched Midnight transaction
  // (NIGHTGATE 0.10.x deterministic batch order). Rendered as one grouped
  // timeline entry so the batching is visible, not just implied by three
  // identical tx links.
  const BATCH_KINDS = ['attest', 'bindPassport', 'anchorContentRoot'];

  function groupStatus(subs) {
    if (subs.some((s) => s.status === 'failed')) return 'failed';
    if (subs.some((s) => s.status === 'running')) return 'running';
    if (subs.every((s) => s.status === 'succeeded')) return 'succeeded';
    if (subs.some((s) => s.status === 'succeeded')) return 'running';
    return 'pending';
  }

  function renderBatchGroup(subs, st) {
    const li = document.createElement('li');
    const status = groupStatus(subs);
    li.className = status + ' batch-group';
    const dot = document.createElement('span'); dot.className = 'step-dot';
    const main = document.createElement('span'); main.className = 'step-main';
    const label = document.createElement('span'); label.className = 'step-label';
    label.textContent = 'Anchor passport on-chain';
    const badge = document.createElement('span'); badge.className = 'batch-badge';
    badge.textContent = subs.length + ' circuits · 1 batched transaction';
    const state = document.createElement('span'); state.className = 'step-state';
    state.textContent = status === 'pending' && st && st.state === 'queued' ? waitingText(st) : status;
    main.append(label, badge, state);
    const info = document.createElement('div');
    info.className = 'step-info';
    info.textContent = 'All three anchor circuits are merged into a SINGLE Midnight transaction: the data fingerprint, your passport id binding and the provable-field root land together, atomically.';
    main.append(info);

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

    // One shared tx link; per-substep links only if the server ever anchors
    // in separate transactions (older plugin fallback).
    const txs = [...new Set(subs.filter((s) => s.txHash).map((s) => s.txHash))];
    if (txs.length === 1) {
      const s = subs.find((x) => x.txHash);
      const tx = document.createElement('div'); tx.className = 'step-tx';
      const a = document.createElement('a');
      a.href = s.explorerUrl || '#'; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'batched tx ' + s.txHash.slice(0, 20) + '…';
      tx.append(a); main.append(tx);
    } else if (txs.length > 1) {
      for (const s of subs.filter((x) => x.txHash)) {
        const tx = document.createElement('div'); tx.className = 'step-tx';
        const a = document.createElement('a');
        a.href = s.explorerUrl || '#'; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = (s.label || s.kind) + ': tx ' + s.txHash.slice(0, 20) + '…';
        tx.append(a); main.append(tx);
      }
    }
    li.append(dot, main);
    return li;
  }

  function renderSteps(steps, st) {
    const ol = $('timeline');
    ol.innerHTML = '';
    let batchSubs = null;
    for (const s of steps) {
      if (BATCH_KINDS.includes(s.kind)) {
        if (!batchSubs) {
          batchSubs = steps.filter((x) => BATCH_KINDS.includes(x.kind));
          ol.append(renderBatchGroup(batchSubs, st));
        }
        continue; // rendered inside the group
      }
      const li = document.createElement('li');
      li.className = s.status;
      const dot = document.createElement('span'); dot.className = 'step-dot';
      const main = document.createElement('span'); main.className = 'step-main';
      const label = document.createElement('span'); label.className = 'step-label'; label.textContent = s.label || s.kind;
      const state = document.createElement('span'); state.className = 'step-state';
      state.textContent = s.status === 'pending' && st && st.state === 'queued'
        ? waitingText(st) : s.status;
      main.append(label, state);
      if (STEP_INFO[s.kind]) {
        const info = document.createElement('div');
        info.className = 'step-info';
        info.textContent = STEP_INFO[s.kind];
        main.append(info);
      }
      if (s.txHash) {
        const tx = document.createElement('div'); tx.className = 'step-tx';
        const a = document.createElement('a');
        a.href = s.explorerUrl || '#'; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = 'tx ' + s.txHash.slice(0, 20) + '…';
        tx.append(a); main.append(tx);
      }
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
    if (published) {
      links.push(`<a href="https://zkpassport.eu/p/${encodeURIComponent(pid)}" target="_blank" rel="noopener">View it on the public explorer (zkpassport.eu)</a>`);
    }
    // This instance's own passport explorer (with auto-verify on open). The
    // deployed demo host serves it too: PASSPORT_PUBLIC_SURFACE=demo,explorer.
    links.push(`<a href="/explorer/#/p/${encodeURIComponent(pid)}" target="_blank" rel="noopener">View your passport in the explorer (with live on-chain verification)</a>`);
    const proof = steps.find((s) => s.kind === 'provePredicate' && s.txHash);
    if (proof) {
      links.push(`<a href="${proof.explorerUrl}" target="_blank" rel="noopener">View the proof predicate transaction on the Midnight explorer</a>`);
    }
    const secondLife = steps.find((s) => s.kind === 'secondLife' && s.status === 'succeeded');
    if (secondLife) {
      links.push('<span class="hint">Your battery lived a second life: it aged, was repurposed and re-anchored as version 2. The explorer page shows its full anchor history; version 1 stays verifiable forever.</span>');
    }
    $('doneLinks').innerHTML = links.join('') || '';
    show('viewDone');
  }

  // ---------- start over ----------

  function restart() {
    clearInterval(pollTimer);
    for (const k of ['testerId', 'night', 'shielded', 'runId', 'passportId', 'parked']) store.del(k);
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
  else if (store.get('testerId') && !store.get('parked')) enterForm();
  else void initLanding();
})();
