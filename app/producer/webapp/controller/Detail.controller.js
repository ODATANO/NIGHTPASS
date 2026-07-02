sap.ui.define([
  "producer/controller/BaseController",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel"
], function (BaseController, Filter, FilterOperator, Sorter, Fragment, JSONModel) {
  "use strict";

  return BaseController.extend("producer.controller.Detail", {

    onInit: function () {
      this._router().getRoute("detail").attachPatternMatched(this._onMatched, this);
      // Submit mode for the top action buttons + whether the passport is anchored
      // on-chain (Grant/Revoke/Prove gate; the Page context does not reliably
      // reach headerContent buttons, so drive it from an absolute named-model flag).
      this.getView().setModel(new JSONModel({ mode: "wallet", anchored: false }), "ui");
      // Catena-X tab: generated aspect JSON + built PAC.
      this.getView().setModel(new JSONModel({ aspect: "", pac: "" }), "cx");
    },

    // The top action buttons route to the wallet (Lace) or server handler based
    // on the selected mode. The per-tab forms (partner/level, field/threshold)
    // supply the inputs; the buttons live in the page header.
    _mode: function () { return this.getView().getModel("ui").getProperty("/mode"); },
    onAttest:       function () { return this._mode() === "server" ? this.onSubmit()  : this.onSignWithLace(); },
    onGrantAction:  function () { return this._mode() === "server" ? this.onGrant()   : this.onGrantWithLace(); },
    onRevokeAction: function () { return this._mode() === "server" ? this.onRevoke()  : this.onRevokeWithLace(); },
    onProveAction:  function () { return this._mode() === "server" ? this.onProve()   : this.onProveWithLace(); },

    _onMatched: function (oEvent) {
      var sKey = decodeURIComponent(oEvent.getParameter("arguments").key);
      // sKey is the entity key predicate; the raw id (for filtering the log
      // tables by passport_ID) is that value without any "ID=" prefix / quotes.
      this._key = sKey;
      this._id = sKey.replace(/^ID=/, "").replace(/^'|'$/g, "");
      this.getView().bindElement({
        path: "/Passports(" + sKey + ")",
        parameters: { $expand: "batteries" },
        events: { dataReceived: this._syncAnchored.bind(this) }
      });
      this._filterLogs(this._id);
      this._syncAnchored();
    },

    // Refresh the on-chain-anchored flag (Grant/Revoke/Prove enablement) from the
    // passport's status. requestProperty forces `status` into $select and returns
    // the freshly loaded value, so it works regardless of other bindings.
    _syncAnchored: function () {
      var oCtx = this.getView().getBindingContext();
      var oUi = this.getView().getModel("ui");
      if (!oCtx) { oUi.setProperty("/anchored", false); return; }
      oCtx.requestProperty("status").then(function (s) {
        oUi.setProperty("/anchored", s === "anchored");
      }).catch(function () { oUi.setProperty("/anchored", false); });
    },

    _filterLogs: function (sKey) {
      var oFilter = new Filter("passport_ID", FilterOperator.EQ, sKey);
      var oSorter = new Sorter("createdAt", true); // newest first
      ["txTable", "discTable", "proofTable"].forEach(function (sId) {
        var oCtrl = this.byId(sId);
        var oBinding = oCtrl && oCtrl.getBinding("items");
        if (oBinding) { oBinding.filter(oFilter); oBinding.sort(oSorter); }
      }.bind(this));
    },

    _refreshAll: function () {
      var oCtx = this.getView().getBindingContext();
      if (oCtx) { oCtx.refresh(); }
      ["txTable", "discTable", "proofTable"].forEach(function (sId) {
        var oBinding = this.byId(sId) && this.byId(sId).getBinding("items");
        if (oBinding) { oBinding.refresh(); }
      }.bind(this));
      this._syncAnchored();
    },

    _pid: function () {
      var oCtx = this.getView().getBindingContext();
      return oCtx ? oCtx.getProperty("passportId") : null;
    },

    onNavBack: function () {
      this._router().navTo("main");
    },

    // ---- Catena-X: aspect JSON + PAC ----------------------------------------
    _cx: function () { return this.getView().getModel("cx"); },
    _unwrap: function (res) { return (res && (res.value != null ? res.value : res)) || ""; },

    onGenerateAspect: function () {
      var that = this;
      this.callAction("/passportAspectJson", { passportId: this._pid() })
        .then(function (res) { that._cx().setProperty("/aspect", that._unwrap(res)); })
        .catch(function (e) { that.error(e); });
    },

    onBuildPac: function () {
      var that = this;
      this.callAction("/passportCredential", { passportId: this._pid() })
        .then(function (res) {
          var pac = that._unwrap(res);
          that._cx().setProperty("/pac", pac);
          try {
            var subj = JSON.parse(pac).credentialSubject || {};
            if (!(subj.predicateProofs || []).length) { that.toast("PAC built, but no proven predicates yet — run a Prove first."); }
          } catch (e) { /* ignore */ }
        })
        .catch(function (e) { that.error(e); });
    },

    onDownloadAspect: function () { this._download(this._pid() + "-aspect.json", this._cx().getProperty("/aspect")); },
    onDownloadPac: function () { this._download(this._pid() + "-pac.json", this._cx().getProperty("/pac")); },

    _download: function (sName, sText) {
      if (!sText) { return; }
      var a = document.createElement("a");
      a.href = "data:application/json;charset=utf-8," + encodeURIComponent(sText);
      a.download = sName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    },

    onRefresh: function () {
      this._refreshAll();
    },

    // ---- server on-chain path ----

    onSubmit: function () {
      var oCtx = this.getView().getBindingContext();
      if (oCtx && oCtx.getProperty("status") === "anchored") {
        return this.toast("passport is already anchored on-chain");
      }
      var that = this;
      this.callAction("/submitPassport", { passportId: this._pid() })
        .then(function (res) { that.toast("submit: " + res.mode + (res.txHash ? " · tx " + res.txHash.slice(0, 16) + "…" : "")); that._refreshAll(); })
        .catch(function (e) { that.error(e); });
    },

    onGrant: function () {
      var that = this;
      var sGrantee = this.byId("granteePartner").getSelectedKey();
      if (!sGrantee) { return this.toast("select a partner"); }
      this.callAction("/grantPassportDisclosure", {
        passportId: this._pid(), grantee: sGrantee, level: parseInt(this.byId("grantLevel").getSelectedKey(), 10)
      }).then(function (res) { that.toast("grant: " + res.mode); that._refreshAll(); })
        .catch(function (e) { that.error(e); });
    },

    onRevoke: function () {
      var that = this;
      var sGrantee = this.byId("granteePartner").getSelectedKey();
      if (!sGrantee) { return this.toast("select a partner"); }
      this.callAction("/revokePassportDisclosure", { passportId: this._pid(), grantee: sGrantee })
        .then(function (res) { that.toast("revoke: " + res.mode); that._refreshAll(); })
        .catch(function (e) { that.error(e); });
    },

    onProve: function () {
      var that = this;
      this.callAction("/provePassportValue", {
        passportId: this._pid(),
        sourceField: this.byId("proofField").getSelectedKey(),
        predicate: this.byId("proofPredicate").getSelectedKey(),
        threshold: Number(this.byId("proofThreshold").getValue()),
        unit: this.byId("proofUnit").getValue()
      }).then(function (res) {
        that.toast("prove: " + res.mode + (res.result === true ? " · ✓ proven" : res.result === false ? " · false" : ""));
        that._refreshAll();
      }).catch(function (e) { that.error(e); });
    },

    _randHex32: function () {
      var b = new Uint8Array(32);
      window.crypto.getRandomValues(b);
      return Array.from(b, function (x) { return x.toString(16).padStart(2, "0"); }).join("");
    },

    // Per-field predicate presets (human units; the value is scaled ×1000 in the
    // service/circuit). Picking a field sets a sensible operator + threshold + unit.
    _FIELD_META: {
      carbonFootprintKgCO2:   { unit: "kg CO₂ / kWh", op: "lessOrEqual",    threshold: 4000 },
      capacityKwh:            { unit: "kWh",           op: "greaterOrEqual", threshold: 60 },
      recycledContentPct:     { unit: "%",             op: "greaterOrEqual", threshold: 16 },
      cycleLife:              { unit: "cycles",        op: "greaterOrEqual", threshold: 3000 },
      roundTripEfficiencyPct: { unit: "%",             op: "greaterOrEqual", threshold: 90 },
      leadContentPpm:         { unit: "ppm",           op: "lessOrEqual",    threshold: 100 },
      recycledCoPct:          { unit: "%",             op: "greaterOrEqual", threshold: 16 },
      recycledLiPct:          { unit: "%",             op: "greaterOrEqual", threshold: 6 },
      recycledNiPct:          { unit: "%",             op: "greaterOrEqual", threshold: 6 }
    },

    onProofFieldChange: function () {
      var m = this._FIELD_META[this.byId("proofField").getSelectedKey()];
      if (!m) { return; }
      this.byId("proofPredicate").setSelectedKey(m.op);
      this.byId("proofThreshold").setValue(String(m.threshold));
      this.byId("proofUnit").setValue(m.unit);
    },

    onProveWithLace: function () {
      var oCtx = this.getView().getBindingContext();
      var ph = oCtx.getProperty("payloadHash") || "";
      if (!ph) { return this.toast("attest the passport with Lace first"); }
      var field = this.byId("proofField").getSelectedKey() || "carbonFootprintKgCO2";
      var predicate = this.byId("proofPredicate").getSelectedKey();
      var thr = Number(this.byId("proofThreshold").getValue());
      var unit = this.byId("proofUnit").getValue();
      var op = predicate === "greaterOrEqual" ? 1 : 0;
      var thresholdScaled = Math.round(thr * 1000);
      var that = this;
      // Resolve the value + field-bound inclusion proof server-side (the producer
      // owns it) — can't read the to-many `batteries` nav via getProperty in v4.
      // The field-bound circuit binds the proven value to THIS passport's field
      // via the content root anchored at attest time (no free-witness value).
      this.callAction("/passportFieldValue", { passportId: this._pid(), sourceField: field }).then(function (res) {
        if (!res || !res.found || res.value === "") { return that.toast("value for '" + field + "' not found on the passport"); }
        if (!res.fieldKey || res.scaledValue === "" || !res.siblingsJson) { return that.toast("field '" + field + "' is not a provable field"); }
        var rawVal = Number(res.value);
        var siblings, dirs;
        try { siblings = JSON.parse(res.siblingsJson); dirs = JSON.parse(res.dirsJson); }
        catch (e) { return that.toast("invalid inclusion proof"); }
        that._lace("Prove field predicate with Lace", async function (mod, api, append) {
          append("proving the passport's own " + field + " (" + rawVal + ") " + (op === 0 ? "≤ " : "≥ ") + thr + " — bound to the anchored content root, value hidden…");
          try {
            await mod.proveFieldPredicate(api, {
              contractAddress: that._VAULT, payloadHash: ph, fieldKey: res.fieldKey,
              threshold: thresholdScaled, op: op, fieldValue: res.scaledValue, siblings: siblings, dirs: dirs
            }, append);
          } catch (e) {
            var msg = (e && (e.message || String(e))) || "";
            // The circuit rejects a predicate that does not hold ("failed assert:
            // predicate false") — no tx lands. Record it as a failed proof so the
            // cockpit shows the negative result, not just a log line.
            if (/predicate false/i.test(msg)) {
              append("predicate does NOT hold for the passport's value — the circuit rejected it (no tx). Recording a failed proof.");
              await that.callAction("/recordWalletPredicate", { passportId: that._pid(), sourceField: field, predicate: predicate, threshold: thresholdScaled, unit: unit, txHash: "", result: false });
              that._refreshAll(); append("done."); that.toast("predicate false — recorded");
              return;
            }
            throw e; // a real error: let the outer handler surface it
          }
          var r = await that._resolveHash(mod, append);
          append("saving proof in cockpit…");
          await that.callAction("/recordWalletPredicate", { passportId: that._pid(), sourceField: field, predicate: predicate, threshold: thresholdScaled, unit: unit, txHash: r.hash, result: true });
          that._refreshAll(); append("done."); that.toast("field-bound predicate proven via Lace");
        });
      }).catch(function (e) { that.error(e); });
    },

    // ---- wallet on-chain path: run the Lace flow IN-APP (no redirect) --------
    // Dynamic-imports the connector building blocks (Vite lib bundle at
    // /connector/lib) and runs attest right here; Lace pops up over the cockpit.
    // The passport payloadHash is attested on the demo AttestationVault.

    _VAULT: "93f0c359aaaaedcf213f0945003e985f0045c12b8c46cba6d620ec6f9f6109b1",

    // Run a wallet flow in-app: open the log dialog, load the connector lib,
    // connect Lace, then invoke fnRun(mod, api, append). Shared by attest / grant /
    // revoke so Lace pops over the cockpit for each.
    _lace: async function (sTitle, fnRun) {
      var oWallet = new JSONModel({ title: sTitle, log: "", busy: false });
      this.getView().setModel(oWallet, "wallet");
      var append = function (m) { oWallet.setProperty("/log", oWallet.getProperty("/log") + m + "\n"); };
      var that = this;
      if (!this._pWalletLog) {
        this._pWalletLog = Fragment.load({ id: this.getView().getId(), name: "producer.fragment.WalletLogDialog", controller: this })
          .then(function (d) { that.getView().addDependent(d); return d; });
      }
      var oDialog = await this._pWalletLog;
      oDialog.open();
      oWallet.setProperty("/busy", true);
      try {
        append("loading connector library (first run downloads ~10MB WASM)…");
        var mod = await import("/connector/lib/nightpass-connector.js");
        var w = mod.listWallets();
        if (!w.length) { append("No Midnight wallet found — install & unlock Lace on Preview."); return; }
        append("connecting " + w[0].name + " — approve the Lace popup…");
        var api = await mod.connect(w[0].key);
        await fnRun(mod, api, append);
      } catch (e) { append("ERROR: " + ((e && (e.stack || e.message)) || e)); }
      finally { oWallet.setProperty("/busy", false); }
    },

    _resolveHash: async function (mod, append) {
      var id = (mod.getLastTxId && mod.getLastTxId()) || "";
      var hash = "";
      try { append("confirming on chain…"); var v = await mod.verifyTxOnChain(id, {}, append); hash = (v && v.hash) || ""; } catch (e) { /* keep identifier */ }
      return { id: id, hash: hash };
    },

    onSignWithLace: function () {
      var oCtx = this.getView().getBindingContext();
      if (!oCtx) { return; }
      var ph = oCtx.getProperty("payloadHash") || "";
      if (!ph) { return this.toast("passport has no payloadHash yet — save it first"); }
      var that = this;
      // Fetch the content root (Merkle over the passport's provable fields) so
      // attest also anchors it — this is what later field-bound proofs bind to.
      this.callAction("/passportFieldValue", { passportId: this._pid(), sourceField: "carbonFootprintKgCO2" }).then(function (res) {
        var contentRoot = (res && res.contentRoot) || "";
        that._lace("Attest with Lace", async function (mod, api, append) {
          append("attesting the passport hash on-chain (prove -> balance -> submit)…");
          await mod.attest(api, { contractAddress: that._VAULT, payloadHash: ph, metadataHash: ph }, append);
          var r = await that._resolveHash(mod, append);
          append("saving tx in cockpit…");
          await that.callAction("/recordWalletAttest", { passportId: that._pid(), txHash: r.hash, identifier: r.id, contractAddress: that._VAULT });
          if (contentRoot) {
            append("anchoring content root (binds passport fields for field-bound proofs)…");
            await mod.anchorContentRoot(api, { contractAddress: that._VAULT, payloadHash: ph, contentRoot: contentRoot }, append);
            await that._resolveHash(mod, append);
          }
          that._refreshAll(); append("done."); that.toast("attest via Lace saved");
        });
      }).catch(function (e) { that.error(e); });
    },

    onGrantWithLace: function () {
      var g = this.byId("granteePartner").getSelectedKey();
      if (!g) { return this.toast("select a partner"); }
      var lvl = parseInt(this.byId("grantLevel").getSelectedKey(), 10);
      var ph = this.getView().getBindingContext().getProperty("payloadHash") || "";
      if (!ph) { return this.toast("attest the passport with Lace first"); }
      var that = this;
      this._lace("Grant with Lace", async function (mod, api, append) {
        append("granting disclosure level " + lvl + " on-chain…");
        await mod.grantDisclosure(api, { contractAddress: that._VAULT, payloadHash: ph, grantee: g, level: lvl }, append);
        var r = await that._resolveHash(mod, append);
        append("saving grant in cockpit…");
        await that.callAction("/recordWalletDisclosure", { passportId: that._pid(), grantee: g, level: lvl, op: "grant", txHash: r.hash });
        that._refreshAll(); append("done."); that.toast("grant via Lace saved");
      });
    },

    onRevokeWithLace: function () {
      var g = this.byId("granteePartner").getSelectedKey();
      if (!g) { return this.toast("select a partner"); }
      var ph = this.getView().getBindingContext().getProperty("payloadHash") || "";
      if (!ph) { return this.toast("attest the passport with Lace first"); }
      var that = this;
      this._lace("Revoke with Lace", async function (mod, api, append) {
        append("revoking disclosure on-chain…");
        await mod.revokeDisclosure(api, { contractAddress: that._VAULT, payloadHash: ph, grantee: g }, append);
        var r = await that._resolveHash(mod, append);
        append("saving revoke in cockpit…");
        await that.callAction("/recordWalletDisclosure", { passportId: that._pid(), grantee: g, level: 0, op: "revoke", txHash: r.hash });
        that._refreshAll(); append("done."); that.toast("revoke via Lace saved");
      });
    },

    onWalletLogClose: function () {
      this.byId("walletLogDialog").close();
    },

    // ---- share with supplier (resolve link + QR + auto-grant + credential) ----

    onShare: function () {
      var oCtx = this.getView().getBindingContext();
      if (!oCtx) { return; }
      var sHash = oCtx.getProperty("payloadHash") || "";
      var sPid = oCtx.getProperty("passportId") || "";
      this.getView().setModel(new JSONModel({
        passportId: sPid,
        payloadHash: sHash,
        resolveUrl: window.location.origin + "/resolve/" + sHash,
        qrUrl: "/qr/" + encodeURIComponent(sPid) + ".png",
        grantee: "",
        level: "2"
      }), "share");
      var that = this;
      if (!this._pShare) {
        this._pShare = Fragment.load({
          id: this.getView().getId(),
          name: "producer.fragment.ShareDialog",
          controller: this
        }).then(function (oDialog) { that.getView().addDependent(oDialog); return oDialog; });
      }
      this._pShare.then(function (oDialog) { oDialog.open(); });
    },

    onShareGrant: function () {
      var oShare = this.getView().getModel("share");
      var sGrantee = (oShare.getProperty("/grantee") || "").trim();
      if (!sGrantee) { return this.toast("enter the supplier's grantee (32-byte hex)"); }
      var that = this;
      this.callAction("/grantPassportDisclosure", {
        passportId: this._pid(), grantee: sGrantee, level: parseInt(oShare.getProperty("/level"), 10)
      }).then(function (res) { that.toast("supplier granted (" + res.mode + ")"); that._refreshAll(); })
        .catch(function (e) { that.error(e); });
    },

    onCopyLink: function () {
      var sUrl = this.getView().getModel("share").getProperty("/resolveUrl");
      var that = this;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(sUrl).then(function () { that.toast("resolve link copied"); });
      } else { this.toast(sUrl); }
    },

    onDownloadCredential: function () {
      var sHash = this.getView().getModel("share").getProperty("/payloadHash");
      var that = this;
      // passportCredential is a function returning the credential JSON string.
      var oOp = this._model().bindContext("/passportCredential(...)");
      oOp.setParameter("payloadHash", sHash);
      this.setBusy(true);
      oOp.invoke().then(function () {
        var oRes = oOp.getBoundContext().getObject();
        var sJson = (oRes && oRes.value) || oRes;
        var oBlob = new Blob([sJson], { type: "application/json" });
        var oUrl = window.URL.createObjectURL(oBlob);
        var oA = document.createElement("a");
        oA.href = oUrl; oA.download = "battery-passport-credential.json";
        document.body.appendChild(oA); oA.click(); oA.remove();
        window.URL.revokeObjectURL(oUrl);
        that.toast("credential downloaded");
      }).catch(function (e) { that.error(e); }).finally(function () { that.setBusy(false); });
    },

    onShareClose: function () {
      this.byId("shareDialog").close();
    }
  });
});
