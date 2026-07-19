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

  async function api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
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

  async function initLanding() {
    show('viewLanding');
    try {
      const info = await api('GET', '/demoInfo()');
      if (!info.enabled) {
        $('btnStart').disabled = true;
        $('landingInfo').textContent = 'The demo is currently closed. Try again later.';
        return;
      }
      const running = info.runningCount ?? info.queueDepth ?? 0;
      const waiting = info.waitingCount ?? 0;
      const busy = running || waiting
        ? `${running} passport${running === 1 ? '' : 's'} being anchored now${waiting ? `, ${waiting} waiting` : ''}. `
        : '';
      $('landingInfo').textContent = `${busy}${info.dailyRemaining} demo passports left today.`;
      if (info.dailyRemaining <= 0) {
        $('btnStart').disabled = true;
        $('landingInfo').textContent = 'Today’s on-chain budget is used up. Come back tomorrow.';
      }
    } catch {
      $('landingInfo').textContent = 'Could not reach the demo service.';
      $('btnStart').disabled = true;
    }
  }

  $('btnStart').addEventListener('click', async () => {
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

  function enterForm() {
    $('idNight').textContent = store.get('night') || '';
    $('idShielded').textContent = store.get('shielded') || '';
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

  $('passportForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('formError').textContent = '';
    const co2 = Number($('fCo2').value), thr = Number($('fThreshold').value);
    if (co2 > thr) {
      $('formError').textContent = 'The threshold must be at least the CO2 value: the demo proves a TRUE claim.';
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
        proveThreshold: thr
      });
      store.set('runId', r.runId);
      store.set('passportId', r.passportId);
      resetLoading($('btnCreate'));
      enterRun();
    } catch (e) {
      $('formError').textContent = e.message;
      resetLoading($('btnCreate'));
    }
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

  function renderSteps(steps, st) {
    const ol = $('timeline');
    ol.innerHTML = '';
    for (const s of steps) {
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
    // Explorer link only when the run actually published there. The local
    // '/explorer/' fallback is deliberately gone: on the deployed demo host
    // the surface gate 404s it (only /demo is public), so the link would
    // point at a dead route exactly when publish failed.
    const published = steps.some((s) => s.kind === 'publish' && s.status === 'succeeded');
    if (published) {
      links.push(`<a href="https://zkpassport.eu/p/${encodeURIComponent(pid)}" target="_blank" rel="noopener">View it on the public explorer (zkpassport.eu)</a>`);
    }
    const proof = steps.find((s) => s.kind === 'provePredicate' && s.txHash);
    if (proof) {
      links.push(`<a href="${proof.explorerUrl}" target="_blank" rel="noopener">View the proof predicate transaction on the Midnight explorer</a>`);
    }
    $('doneLinks').innerHTML = links.join('') || '';
    show('viewDone');
  }

  // ---------- start over ----------

  function restart() {
    clearInterval(pollTimer);
    for (const k of ['testerId', 'night', 'shielded', 'runId', 'passportId']) store.del(k);
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
  else if (store.get('testerId')) enterForm();
  else void initLanding();
})();
