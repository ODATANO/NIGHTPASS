sap.ui.define([
  "producer/controller/BaseController",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "producer/util/WalletPicker",
  "sap/m/MessageBox"
], function (BaseController, Filter, FilterOperator, Sorter, Fragment, JSONModel, WalletPicker, MessageBox) {
  "use strict";

  return BaseController.extend("producer.controller.Detail", {

    onInit: function () {
      this._router().getRoute("detail").attachPatternMatched(this._onMatched, this);
      // Whether the passport is anchored on-chain (Grant/Revoke/Prove gate; the
      // Page context does not reliably reach headerContent buttons, so drive it
      // from an absolute named-model flag).
      this.getView().setModel(new JSONModel({ anchored: false }), "ui");
      // Catena-X tab: generated aspect JSON + built PAC.
      this.getView().setModel(new JSONModel({ aspect: "", pac: "" }), "cx");
      // Conformance tab: BatteryPass-Ready validation result.
      this.getView().setModel(new JSONModel({ busy: false, text: "", state: "None", valid: false, issues: [] }), "conf");
      this.getView().setModel(new JSONModel({ busy: false, text: "", state: "None" }), "dd");
      // Proof cart (wallet mode): collected claims, proven together in ONE tx.
      this.getView().setModel(new JSONModel({ items: [] }), "cart");
    },

    // Publish the anchored passport to the public explorer instance.
    onPublish: function () {
      var that = this;
      this.callAction("/publishPassport", { passportId: this._pid() })
        .then(function (r) {
          if (r.published) { that.toast("published to " + r.target + " (" + r.status + ")"); }
          else { that.error("publish failed: " + r.status); }
        })
        .catch(function (e) { that.error(e); });
    },

    // Official BatteryPass-Ready validation (server-proxied; the API session
    // stays on the server). Feeds the publish gate: publishing wants a green run.
    onValidateConformance: function () {
      var that = this;
      var oConf = this.getView().getModel("conf");
      oConf.setData({ busy: true, text: "Validating against the official test environment…", state: "Information", valid: false, issues: [] });
      this.callAction("/validatePassportConformance", { passportId: this._pid() })
        .then(function (r) {
          var text, state;
          if (r.error) { text = r.error; state = "Warning"; }
          else if (r.valid) { text = "Conformant · 0 findings (" + r.guide + ")"; state = "Success"; }
          else { text = r.errorCount + " finding(s) against " + r.guide + ", see below"; state = "Error"; }
          oConf.setData({ busy: false, text: text, state: state, valid: !!r.valid, issues: r.issues || [] });
          that._session().setProperty("/lastValidated", r.valid ? that._pid() : "");
        })
        .catch(function (e) {
          oConf.setData({ busy: false, text: String((e && e.message) || e), state: "Error", valid: false, issues: [] });
        });
    },

    // Due-diligence upload: native file picker (no extra UI5 lib), file goes
    // base64 through the uploadDiligenceDoc action; the sha256 anchor runs
    // detached on the server and the row poll below reports the outcome.
    onUploadDiligence: function () {
      var that = this;
      var oInput = document.createElement("input");
      oInput.type = "file";
      oInput.accept = ".pdf,.json,.txt,.png,.jpg,.jpeg";
      oInput.onchange = function () {
        var oFile = oInput.files && oInput.files[0];
        if (!oFile) { return; }
        if (oFile.size > 8 * 1024 * 1024) { that.toast("file exceeds the 8 MB limit"); return; }
        var oReader = new FileReader();
        oReader.onload = function () {
          var sBase64 = String(oReader.result).split(",")[1] || "";
          that._uploadDiligence(oFile, sBase64);
        };
        oReader.readAsDataURL(oFile);
      };
      oInput.click();
    },

    _uploadDiligence: function (oFile, sBase64) {
      var that = this;
      var oDd = this.getView().getModel("dd");
      oDd.setData({ busy: true, text: "Uploading and hashing " + oFile.name + "…", state: "Information" });
      this.callAction("/uploadDiligenceDoc", {
        passportId: this._pid(),
        docType: this.byId("ddDocType").getValue() || "supply-chain-due-diligence-report",
        fileName: oFile.name,
        mimeType: oFile.type || "application/pdf",
        contentBase64: sBase64,
        walletId: this._walletId()
      }).then(function (res) {
        if (res.mode === "anchoring") {
          oDd.setData({ busy: false, text: "sha256 " + res.sha256.substring(0, 16) + "… · anchoring in the background", state: "Information" });
          that._pollDiligence(res.docId);
        } else {
          oDd.setData({ busy: false, text: "stored without anchor (no signing session) · sha256 " + res.sha256.substring(0, 16) + "…", state: "Warning" });
        }
        that._refreshAll();
      }).catch(function (e) {
        oDd.setData({ busy: false, text: String((e && e.message) || e), state: "Error" });
      });
    },

    _pollDiligence: function (sDocId) {
      var that = this;
      var iTries = 0;
      var poll = function () {
        if (++iTries > 60) { return; } // ~5 min cap; the row keeps its state
        fetch("/api/v1/producer/DiligenceDoc(" + sDocId + ")?$select=status,anchorTxHash", { headers: that._authHeaders() })
          .then(function (r) { return r.json(); })
          .then(function (row) {
            if (row.status === "succeeded") {
              that.getView().getModel("dd").setData({
                busy: false, state: "Success",
                text: "document anchored · tx " + String(row.anchorTxHash || "").substring(0, 12) + "…"
              });
              that.toast("due-diligence document anchored on-chain");
              that._refreshAll();
            } else if (row.status === "failed") {
              that.getView().getModel("dd").setData({
                busy: false, text: "anchoring failed (see Transactions tab)", state: "Error"
              });
              that._refreshAll();
            } else { setTimeout(poll, 5000); }
          })
          .catch(function () { setTimeout(poll, 5000); });
      };
      setTimeout(poll, 5000);
    },

    onDownloadDiligence: function (oEvent) {
      var that = this;
      var oRow = oEvent.getSource().getBindingContext().getObject();
      fetch("/api/v1/producer/diligenceFile(docId=" + oRow.ID + ")", { headers: this._authHeaders() })
        .then(function (r) {
          if (!r.ok) { throw new Error("download failed (HTTP " + r.status + ")"); }
          return r.json();
        })
        .then(function (d) {
          var a = document.createElement("a");
          a.href = "data:" + (d.mimeType || "application/octet-stream") + ";base64," + d.contentBase64;
          a.download = d.fileName || "document";
          a.click();
        })
        .catch(function (e) { that.error(e); });
    },

    // The header buttons dispatch on the signing mode chosen at login:
    //   'wallet' → the in-browser Lace flow (the user signs each tx),
    //   'server' → the server actions, signed by the selected server wallet
    //              (its id travels as `walletId`).
    // The per-tab forms (partner/level, field/threshold) supply the inputs.
    onAttest:       function () { return this._isServer() ? this.onSubmit() : this.onSignWithLace(); },
    onGrantAction:  function () { return this._isServer() ? this.onGrant()  : this.onGrantWithLace(); },
    onRevokeAction: function () { return this._isServer() ? this.onRevoke() : this.onRevokeWithLace(); },
    onProveAction:  function () { return this._isServer() ? this.onProve()  : this.onProveWithLace(); },

    _isServer: function () { return this._session().getProperty("/mode") === "server"; },

    /** Which server wallet signs (server mode); empty in wallet mode. */
    _walletId: function () { return this._session().getProperty("/walletId") || ""; },

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
      // The cart is per passport; navigating to another row empties it.
      this.getView().getModel("cart").setProperty("/items", []);
    },

    // Refresh the on-chain-anchored flag (Grant/Revoke/Prove enablement) from the
    // passport's status. requestProperty forces `status` into $select and returns
    // the freshly loaded value, so it works regardless of other bindings.
    _syncAnchored: function () {
      var oCtx = this.getView().getBindingContext();
      var oUi = this.getView().getModel("ui");
      var that = this;
      if (!oCtx) { oUi.setProperty("/anchored", false); oUi.setProperty("/drifted", false); return; }
      oCtx.requestProperty("status").then(function (s) {
        oUi.setProperty("/anchored", s === "anchored");
        if (s === "anchored") { that._syncDrift(); } else { oUi.setProperty("/drifted", false); }
      }).catch(function () { oUi.setProperty("/anchored", false); oUi.setProperty("/drifted", false); });
      this._syncBatteryStatus();
    },

    // Client copy of the lifecycle transition matrix (server enforces it too;
    // this only drives menu enablement). Sync with srv/lib/battery-lifecycle.ts.
    STATUS_TARGETS: {
      original: ["repurposed", "reused", "remanufactured", "waste"],
      repurposed: ["waste"], reused: ["waste"], remanufactured: ["waste"],
      waste: []
    },

    _syncBatteryStatus: function () {
      var oUi = this.getView().getModel("ui");
      var that = this;
      if (!this._id) { oUi.setProperty("/batteryStatus", ""); oUi.setProperty("/statusTargets", ""); return; }
      fetch("/api/v1/producer/PassportAttributes?$filter=passport_ID eq " + this._id +
        " and attribute eq 'BatteryStatus'&$select=valueJson", { headers: this._authHeaders() })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (b) {
          var sJson = (((b || {}).value || [])[0] || {}).valueJson;
          var sStatus = "original";
          try { sStatus = JSON.parse(sJson).batteryStatusValues || "original"; } catch (e) { /* default */ }
          oUi.setProperty("/batteryStatus", sStatus);
          oUi.setProperty("/statusTargets", (that.STATUS_TARGETS[sStatus] || []).join(","));
        })
        .catch(function () { oUi.setProperty("/batteryStatus", ""); oUi.setProperty("/statusTargets", ""); });
    },

    // First lifecycle step: claim the passport id on-chain. The registrar
    // registers the id to the acting server wallet's attester identity; from
    // then on only this wallet can bind it. Same poll as the handover (both
    // settle a registerPassport transaction row).
    onClaimPassport: function () {
      if (!this._isServer()) { return this.toast("claiming is registrar-signed; log in with a server wallet"); }
      var that = this;
      MessageBox.confirm(
        "Claim the passport id on-chain for this wallet? The registrar registers it to your attester identity; afterwards only this wallet can bind or re-bind the id.",
        {
          title: "Claim passport id",
          actions: ["Claim", MessageBox.Action.CANCEL],
          emphasizedAction: "Claim",
          onClose: function (sAction) {
            if (sAction !== "Claim") { return; }
            that.callAction("/claimPassportId", { passportId: that._pid(), walletId: that._walletId() })
              .then(function (res) {
                that.toast("claim started (registrar tx pending, attester " + (res.ownerAttesterId || "").slice(0, 10) + "...)");
                that._pollRegister(that._pid(), "passport id claim");
                that._refreshAll();
              })
              .catch(function (e) { that.error(e); });
          }
        }
      );
    },

    // Operator handover (Second Life): pick a target server wallet, then the
    // registrar re-registers the passport id on-chain and the owner scope
    // flips. Poll the registerPassport transaction row until it settles.
    onTransferOperator: function () {
      if (!this._isServer()) { return this.toast("operator handover runs through server wallets; log in with a server wallet"); }
      var that = this;
      fetch("/api/v1/producer/listServerWallets()", { headers: this._authHeaders() })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("wallet list failed (" + r.status + ")")); })
        .then(function (b) {
          var aWallets = (b.value || []).filter(function (w) { return w.id !== that._walletId(); });
          if (!aWallets.length) { return that.toast("no other server wallet configured to transfer to"); }
          var oSelect = new sap.m.Select({ width: "100%" });
          aWallets.forEach(function (w) {
            oSelect.addItem(new sap.ui.core.Item({ key: w.id, text: w.label + " (" + w.id + ")" }));
          });
          var oDialog = new sap.m.Dialog({
            title: "Transfer operator",
            contentWidth: "22rem",
            content: [
              new sap.m.Text({ text: "Hand this passport over to another operator wallet. The registrar re-registers the id on-chain; afterwards only the new operator can update or re-anchor it." }).addStyleClass("sapUiSmallMargin"),
              new sap.m.Label({ text: "New operator wallet", labelFor: oSelect }).addStyleClass("sapUiSmallMarginBegin"),
              oSelect
            ],
            beginButton: new sap.m.Button({
              text: "Transfer", type: "Emphasized",
              press: function () {
                var sTarget = oSelect.getSelectedKey();
                oDialog.close();
                that.callAction("/transferPassportOperator", { passportId: that._pid(), newWalletId: sTarget })
                  .then(function (res) {
                    that.toast("handover to '" + sTarget + "' " +
                      (res.mode === "transferring" ? "started (registrar tx pending)" : "done (" + res.mode + ")") +
                      ((res.activeGrants || []).length ? "; " + res.activeGrants.length + " grant(s) to re-issue" : ""));
                    if (res.mode === "transferring") { that._pollRegister(that._pid(), "operator handover"); }
                    that._refreshAll();
                  })
                  .catch(function (e) { that.error(e); });
              }
            }),
            endButton: new sap.m.Button({ text: "Cancel", press: function () { oDialog.close(); } }),
            afterClose: function () { oDialog.destroy(); }
          });
          that.getView().addDependent(oDialog);
          oDialog.open();
        })
        .catch(function (e) { that.error(e); });
    },

    // Poll the newest registerPassport transaction row until it settles.
    // Shared by the id claim and the operator handover; sWhat labels the toasts.
    _pollRegister: function (sPid, sWhat) {
      var that = this;
      var nToken = (this._transferToken = (this._transferToken || 0) + 1);
      var iLeft = 60;
      var tick = function () {
        if (nToken !== that._transferToken || iLeft-- <= 0) { return; }
        fetch("/api/v1/producer/Passports?$select=ID&$filter=passportId eq '" + encodeURIComponent(sPid) + "'", { headers: that._authHeaders() })
          .then(function (r) { return r.json(); })
          .then(function (b) {
            var sId = ((b.value || [])[0] || {}).ID;
            if (!sId) { return; }
            return fetch("/api/v1/producer/PassportTransactions?$filter=passport_ID eq " + sId +
              " and kind eq 'registerPassport'&$orderby=createdAt desc&$top=1&$select=status,txHash,errorMessage",
              { headers: that._authHeaders() })
              .then(function (r) { return r.json(); })
              .then(function (t) {
                var oRow = (t.value || [])[0] || {};
                if (oRow.status === "succeeded") { that._refreshAll(); return that.toast(sWhat + " of '" + sPid + "' registered on-chain"); }
                if (oRow.status === "failed") { that._refreshAll(); return that.error(sWhat + " failed: " + (oRow.errorMessage || "see Transactions tab")); }
                setTimeout(tick, 5000);
              });
          })
          .catch(function () { if (nToken === that._transferToken) { setTimeout(tick, 8000); } });
      };
      setTimeout(tick, 5000);
    },

    // Lifecycle transition from the status menu: runs changeBatteryStatus and,
    // for anchored passports, follows the detached re-anchor with the same
    // poll as submit/re-anchor.
    onStatusMenu: function (oEvent) {
      var sTarget = oEvent.getParameter("item").getText();
      var that = this;
      this.callAction("/changeBatteryStatus", { passportId: this._pid(), newStatus: sTarget, walletId: this._walletId() })
        .then(function (res) {
          var n = (res.grantsToRegrant || []).length;
          that.toast("battery status: " + res.previousStatus + " > " + res.newStatus +
            (res.mode === "anchoring" ? "; re-anchoring as a new version" : " (" + res.mode + ")") +
            (n ? "; " + n + " grant(s) need re-granting" : ""));
          that._syncBatteryStatus();
          if (res.mode === "anchoring") { that._pollAnchor(that._pid()); }
          that._refreshAll();
        })
        .catch(function (e) { that.error(e); });
    },

    // Drift check: does the current DB content (telemetry updates included)
    // still hash to the anchored payload? Feeds the header warning and the
    // Re-anchor button. Best effort; a failed read just hides the hint.
    _syncDrift: function () {
      var that = this;
      var oUi = this.getView().getModel("ui");
      var sPid = this._pid();
      if (!sPid) { oUi.setProperty("/drifted", false); return; }
      fetch("/api/v1/producer/passportDrift(passportId='" + encodeURIComponent(sPid.replace(/'/g, "''")) + "')",
        { headers: this._authHeaders() })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (b) { oUi.setProperty("/drifted", !!(b && b.drifted)); })
        .catch(function () { oUi.setProperty("/drifted", false); });
    },

    // Re-anchor the passport onto a freshly computed payload hash (new on-chain
    // version; the previous anchor is archived and stays verifiable). Server
    // mode only; runs detached like submit, same poll.
    onReanchor: function () {
      if (!this._isServer()) { return this.toast("re-anchoring runs through a server wallet; log in with a server wallet"); }
      var that = this;
      this.callAction("/reanchorPassport", { passportId: this._pid(), reason: "data-correction", walletId: this._walletId() })
        .then(function (res) {
          var n = (res.grantsToRegrant || []).length;
          that.toast("re-anchoring started" +
            (res.archivedVersion ? " (v" + res.archivedVersion + " archived)" : "") +
            (n ? "; " + n + " grant(s) need re-granting for the new version" : ""));
          that._pollAnchor(that._pid());
          that._refreshAll();
        })
        .catch(function (e) { that.error(e); });
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
            if (!(subj.predicateProofs || []).length) { that.toast("PAC built, but no proven predicates yet. Run a Prove first."); }
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
      this.callAction("/submitPassport", { passportId: this._pid(), walletId: this._walletId() })
        .then(function (res) {
          if (res.mode === "anchoring") {
            // The anchor runs detached on the server; the row stays 'anchoring'.
            // Keep working; the poll below refreshes and notifies on completion.
            that.toast("anchoring started in the background, status is pending");
            that._pollAnchor(that._pid());
          } else {
            that.toast("submit: " + res.mode + (res.txHash ? " · tx " + res.txHash.slice(0, 16) + "…" : ""));
          }
          that._refreshAll();
        })
        .catch(function (e) { that.error(e); });
    },

    // Poll the passport row until the detached anchor runner finishes (anchored
    // or failed), then refresh the views and notify. Bounded to ~10 minutes,
    // matching the server-side job cap. A new submit supersedes a running poll.
    _pollAnchor: function (sPid) {
      var that = this;
      var nToken = (this._anchorToken = (this._anchorToken || 0) + 1);
      var iLeft = 120;
      var tick = function () {
        if (nToken !== that._anchorToken || iLeft-- <= 0) { return; }
        fetch("/api/v1/producer/Passports?$select=status&$filter=passportId eq '" + encodeURIComponent(sPid) + "'",
          { headers: that._authHeaders() })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("status " + r.status)); })
          .then(function (b) {
            if (nToken !== that._anchorToken) { return; }
            var sStatus = ((b.value || [])[0] || {}).status;
            if (sStatus === "anchored") { that._refreshAll(); return that.toast("passport '" + sPid + "' anchored on-chain"); }
            if (sStatus === "failed") { that._refreshAll(); return that.error("anchoring of '" + sPid + "' failed, see the Transactions tab"); }
            setTimeout(tick, 5000);
          })
          .catch(function () { if (nToken === that._anchorToken) { setTimeout(tick, 8000); } });
      };
      setTimeout(tick, 5000);
    },

    onGrant: function () {
      var that = this;
      var sGrantee = this.byId("granteePartner").getSelectedKey();
      if (!sGrantee) { return this.toast("select a partner"); }
      this.callAction("/grantPassportDisclosure", {
        passportId: this._pid(), grantee: sGrantee,
        level: parseInt(this.byId("grantLevel").getSelectedKey(), 10),
        walletId: this._walletId()
      }).then(function (res) { that._afterDisclosure("grant", res); })
        .catch(function (e) { that.error(e); });
    },

    onRevoke: function () {
      var that = this;
      var sGrantee = this.byId("granteePartner").getSelectedKey();
      if (!sGrantee) { return this.toast("select a partner"); }
      this.callAction("/revokePassportDisclosure", { passportId: this._pid(), grantee: sGrantee, walletId: this._walletId() })
        .then(function (res) { that._afterDisclosure("revoke", res); })
        .catch(function (e) { that.error(e); });
    },

    // Grant/revoke run detached on the server (mode 'granting'/'revoking'):
    // notify, then poll the pending DisclosureGrantLog row for the outcome.
    _afterDisclosure: function (sOp, res) {
      if (res.mode === "granting" || res.mode === "revoking") {
        this.toast(sOp + " started in the background, status is pending");
        this._pollGrant(res.grantLogId, sOp);
      } else {
        this.toast(sOp + ": " + res.mode);
      }
      this._refreshAll();
    },

    _pollGrant: function (sLogId, sOp) {
      var that = this;
      var nToken = (this._grantToken = (this._grantToken || 0) + 1);
      var iLeft = 120;
      var tick = function () {
        if (nToken !== that._grantToken || iLeft-- <= 0) { return; }
        fetch("/api/v1/producer/DisclosureGrantLog?$select=status,txHash&$filter=ID eq " + sLogId,
          { headers: that._authHeaders() })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("status " + r.status)); })
          .then(function (b) {
            if (nToken !== that._grantToken) { return; }
            var row = (b.value || [])[0] || {};
            if (row.status === "succeeded") {
              that._refreshAll();
              return that.toast(sOp + " settled on-chain" + (row.txHash ? " · tx " + row.txHash.slice(0, 16) + "…" : ""));
            }
            if (row.status === "failed") {
              that._refreshAll();
              return that.error(sOp + " failed, see the Transactions tab");
            }
            setTimeout(tick, 5000);
          })
          .catch(function () { if (nToken === that._grantToken) { setTimeout(tick, 8000); } });
      };
      setTimeout(tick, 5000);
    },

    onProve: function () {
      var that = this;
      this.callAction("/provePassportValue", {
        passportId: this._pid(),
        sourceField: this.byId("proofField").getSelectedKey(),
        predicate: this.byId("proofPredicate").getSelectedKey(),
        threshold: Number(this.byId("proofThreshold").getValue()),
        unit: this.byId("proofUnit").getValue(),
        walletId: this._walletId()
      }).then(function (res) {
        if (res.mode === "proving") {
          // The ZK proof runs detached on the server; keep working. The log
          // row is 'pending' and the poll below reports the outcome.
          that.toast("proof started in the background, status is pending");
          that._pollProof(res.proofLogId);
        } else {
          that.toast("prove: " + res.mode + (res.result === true ? " · ✓ proven" : res.result === false ? " · false" : ""));
        }
        that._refreshAll();
      }).catch(function (e) { that.error(e); });
    },

    // Poll the pending PredicateProofLog row until the detached proof runner
    // resolves it, then refresh and notify. Bounded like the anchor poll.
    _pollProof: function (sLogId) {
      var that = this;
      var nToken = (this._proofToken = (this._proofToken || 0) + 1);
      var iLeft = 120;
      var tick = function () {
        if (nToken !== that._proofToken || iLeft-- <= 0) { return; }
        fetch("/api/v1/producer/PredicateProofLog?$select=status,result,txHash&$filter=ID eq " + sLogId,
          { headers: that._authHeaders() })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("status " + r.status)); })
          .then(function (b) {
            if (nToken !== that._proofToken) { return; }
            var row = (b.value || [])[0] || {};
            if (row.status === "succeeded") {
              that._refreshAll();
              return that.toast("predicate proven on-chain" + (row.txHash ? " · tx " + row.txHash.slice(0, 16) + "…" : ""));
            }
            if (row.status === "failed") {
              that._refreshAll();
              return that.error("predicate proof failed (or the predicate does not hold), see the Proofs and Transactions tabs");
            }
            setTimeout(tick, 5000);
          })
          .catch(function () { if (nToken === that._proofToken) { setTimeout(tick, 8000); } });
      };
      setTimeout(tick, 5000);
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
      if (!ph) { return this.toast("attest the passport with your wallet first"); }
      var field = this.byId("proofField").getSelectedKey() || "carbonFootprintKgCO2";
      var predicate = this.byId("proofPredicate").getSelectedKey();
      var thr = Number(this.byId("proofThreshold").getValue());
      var unit = this.byId("proofUnit").getValue();
      var op = predicate === "greaterOrEqual" ? 1 : 0;
      var thresholdScaled = Math.round(thr * 1000);
      var that = this;
      // Resolve the value + field-bound inclusion proof server-side (the producer
      // owns it); the to-many `batteries` nav is not readable via getProperty in v4.
      // The field-bound circuit binds the proven value to THIS passport's field
      // via the content root anchored at attest time (no free-witness value).
      this.callAction("/passportFieldValue", { passportId: this._pid(), sourceField: field }).then(function (res) {
        if (!res || !res.found || res.value === "") { return that.toast("value for '" + field + "' not found on the passport"); }
        if (!res.fieldKey || res.scaledValue === "" || !res.siblingsJson) { return that.toast("field '" + field + "' is not a provable field"); }
        var rawVal = Number(res.value);
        var siblings, dirs;
        try { siblings = JSON.parse(res.siblingsJson); dirs = JSON.parse(res.dirsJson); }
        catch (e) { return that.toast("invalid inclusion proof"); }
        that._lace("Prove field predicate with your wallet", async function (mod, api, append, vault) {
          append("proving the passport's own " + field + " (" + rawVal + ") " + (op === 0 ? "≤ " : "≥ ") + thr + ", bound to the anchored content root, value hidden…");
          try {
            await mod.proveFieldPredicate(api, {
              contractAddress: vault, payloadHash: ph, fieldKey: res.fieldKey,
              threshold: thresholdScaled, op: op, fieldValue: res.scaledValue, siblings: siblings, dirs: dirs
            }, append);
          } catch (e) {
            var msg = (e && (e.message || String(e))) || "";
            // The circuit rejects a predicate that does not hold ("failed assert:
            // predicate false"), so no tx lands. Record it as a failed proof so the
            // cockpit shows the negative result, not just a log line.
            if (/predicate false/i.test(msg)) {
              append("predicate does NOT hold for the passport's value; the circuit rejected it (no tx). Recording a failed proof.");
              await that.callAction("/recordWalletPredicate", { passportId: that._pid(), sourceField: field, predicate: predicate, threshold: thresholdScaled, unit: unit, txHash: "", result: false });
              that._refreshAll(); append("done."); that.toast("predicate false, recorded");
              return;
            }
            throw e; // a real error: let the outer handler surface it
          }
          var r = await that._resolveHash(mod, append);
          append("saving proof in cockpit…");
          await that.callAction("/recordWalletPredicate", { passportId: that._pid(), sourceField: field, predicate: predicate, threshold: thresholdScaled, unit: unit, txHash: r.hash, result: true });
          that._refreshAll(); append("done."); that.toast("field-bound predicate proven via wallet");
        });
      }).catch(function (e) { that.error(e); });
    },

    // ---- proof cart: collect claims, prove them all in ONE wallet tx --------
    // Wallet mode only for now: the server lane submits one tx per proof until
    // NIGHTGATE ships the batch pendant (feature request pending); the shared
    // proof-plan module keeps both lanes on the same contract.

    _CART_MAX: 5, // N sequential wasm provings in the browser; keep it modest

    onCartAdd: function () {
      var oCart = this.getView().getModel("cart");
      var aItems = oCart.getProperty("/items") || [];
      if (aItems.length >= this._CART_MAX) {
        return this.toast("cart is full (" + this._CART_MAX + " claims); prove it first");
      }
      var field = this.byId("proofField").getSelectedKey();
      var predicate = this.byId("proofPredicate").getSelectedKey();
      var thr = Number(this.byId("proofThreshold").getValue());
      if (!isFinite(thr) || thr < 0) { return this.toast("threshold must be a non-negative number"); }
      var unit = this.byId("proofUnit").getValue();
      var sKey = field + "|" + predicate + "|" + thr;
      if (aItems.some(function (i) { return i.key === sKey; })) {
        return this.toast("this claim is already in the cart");
      }
      var sFieldLabel = this.byId("proofField").getSelectedItem().getText();
      aItems = aItems.concat([{
        key: sKey, field: field, predicate: predicate, threshold: thr, unit: unit,
        label: sFieldLabel + " " + (predicate === "greaterOrEqual" ? "≥" : "≤") + " " + thr + (unit ? " " + unit : "")
      }]);
      oCart.setProperty("/items", aItems);
      this.toast("claim added (" + aItems.length + " in the cart)");
    },

    onCartRemove: function (oEvent) {
      var oCart = this.getView().getModel("cart");
      var oItem = oEvent.getParameter("listItem");
      var oCtx = oItem && oItem.getBindingContext("cart");
      if (!oCtx) { return; }
      var iIdx = Number(oCtx.getPath().split("/").pop());
      var aItems = (oCart.getProperty("/items") || []).slice();
      aItems.splice(iIdx, 1);
      oCart.setProperty("/items", aItems);
    },

    onCartClear: function () {
      this.getView().getModel("cart").setProperty("/items", []);
    },

    // Prove the whole cart in ONE tx. Dispatches on the signing mode:
    // server -> provePassportValuesBatch (platform batch action, sponsored),
    // wallet -> connector proveFieldPredicateBatch (one approval).
    onProveCart: function () {
      if (this._isServer()) { return this._proveCartServer(); }
      var that = this;
      var oCtx = this.getView().getBindingContext();
      var ph = oCtx && (oCtx.getProperty("payloadHash") || "");
      if (!ph) { return this.toast("attest the passport with your wallet first"); }
      var aItems = this.getView().getModel("cart").getProperty("/items") || [];
      if (!aItems.length) { return this.toast("the cart is empty"); }
      // Server-side resolution first (the producer owns the values); abort
      // before any wallet popup when an item is not provable.
      Promise.all(aItems.map(function (it) {
        return that.callAction("/passportFieldValue", { passportId: that._pid(), sourceField: it.field });
      })).then(function (aRes) {
        var aProofs = [];
        for (var i = 0; i < aItems.length; i++) {
          var res = aRes[i];
          if (!res || !res.found || res.value === "" || !res.fieldKey || res.scaledValue === "" || !res.siblingsJson) {
            return that.toast("'" + aItems[i].field + "' is not provable on this passport; remove it from the cart");
          }
          aProofs.push({
            item: aItems[i],
            fieldKey: res.fieldKey,
            threshold: Math.round(aItems[i].threshold * 1000),
            op: aItems[i].predicate === "greaterOrEqual" ? 1 : 0,
            fieldValue: res.scaledValue,
            siblings: JSON.parse(res.siblingsJson),
            dirs: JSON.parse(res.dirsJson)
          });
        }
        that._lace("Prove " + aProofs.length + " claims in one transaction", async function (mod, api, append, vault) {
          if (typeof mod.proveFieldPredicateBatch !== "function") {
            append("this connector build has no proof cart; falling back is manual (prove claims one by one).");
            return that.toast("connector build too old for the proof cart");
          }
          append("proving " + aProofs.length + " claims bound to the anchored content root (values hidden). "
            + "One approval, one fee; proving still runs once per claim, please wait…");
          try {
            await mod.proveFieldPredicateBatch(api, {
              contractAddress: vault, payloadHash: ph,
              proofs: aProofs.map(function (p) {
                return { fieldKey: p.fieldKey, threshold: p.threshold, op: p.op,
                         fieldValue: p.fieldValue, siblings: p.siblings, dirs: p.dirs };
              })
            }, append);
          } catch (e) {
            var msg = (e && (e.message || String(e))) || "";
            if (/predicate false/i.test(msg)) {
              // The circuit does not say WHICH claim failed; the cart is
              // all-or-nothing and nothing reached the chain.
              append("at least one claim does NOT hold for the passport's values; the whole cart was "
                + "rejected during proving, nothing was submitted. Remove the failing claim and retry "
                + "(claims: " + aProofs.map(function (p) { return p.item.label; }).join(" · ") + ").");
              return that.toast("cart rejected: a claim does not hold");
            }
            throw e;
          }
          var r = await that._resolveHash(mod, append);
          append("saving " + aProofs.length + " proofs in cockpit…");
          for (var j = 0; j < aProofs.length; j++) {
            var p = aProofs[j];
            await that.callAction("/recordWalletPredicate", {
              passportId: that._pid(), sourceField: p.item.field, predicate: p.item.predicate,
              threshold: p.threshold, unit: p.item.unit, txHash: r.hash, result: true
            });
          }
          that.getView().getModel("cart").setProperty("/items", []);
          that._refreshAll(); append("done.");
          that.toast(aProofs.length + " claims proven in one transaction");
        });
      }).catch(function (e) { that.error(e); });
    },

    // Server-mode cart: the server resolves values + inclusion proofs itself;
    // the raw human thresholds travel as claimsJson (scaled server-side, same
    // as the single prove action). The proof runs detached; poll a log row.
    _proveCartServer: function () {
      var that = this;
      var aItems = this.getView().getModel("cart").getProperty("/items") || [];
      if (!aItems.length) { return this.toast("the cart is empty"); }
      this.callAction("/provePassportValuesBatch", {
        passportId: this._pid(),
        claimsJson: JSON.stringify(aItems.map(function (it) {
          return { sourceField: it.field, predicate: it.predicate, threshold: it.threshold, unit: it.unit };
        })),
        walletId: this._walletId()
      }).then(function (res) {
        if (res.mode === "proving") {
          var aIds = [];
          try { aIds = JSON.parse(res.proofLogIds || "[]"); } catch (e) { /* toast below */ }
          that.toast(aItems.length + " claims proving in one background tx"
            + (res.dropped ? " (" + res.dropped + " duplicate(s) dropped)" : ""));
          if (aIds.length) { that._pollProof(aIds[0]); }
          that.getView().getModel("cart").setProperty("/items", []);
        } else {
          that.toast("stored offline (no signing session): " + res.mode);
        }
        that._refreshAll();
      }).catch(function (e) { that.error(e); });
    },

    // ---- wallet on-chain path: run the wallet flow IN-APP (no redirect) ------
    // Dynamic-imports the connector building blocks (Vite lib bundle at
    // /connector/lib) and runs attest right here; the wallet pops up over the
    // cockpit. The passport payloadHash is attested on the SAME AttestationVault
    // the server anchors against, resolved from /runtime-config (a stale
    // UI-baked address would sign into a vault verifyOnChain never reads).

    _vault: function () {
      if (!this._pVault) {
        this._pVault = fetch("/api/v1/passport/runtime-config")
          .then(function (r) { return r.json(); })
          .then(function (cfg) {
            if (!cfg || !cfg.contractAddress) {
              throw new Error("server has no attestation vault configured (PASSPORT_CONTRACT_ADDRESS)");
            }
            return cfg.contractAddress;
          });
        // A failed fetch must not poison every later attempt.
        var that = this;
        this._pVault.catch(function () { that._pVault = null; });
      }
      return this._pVault;
    },

    // Run a wallet flow in-app: open the log dialog, load the connector lib,
    // connect the chosen wallet, then invoke fnRun(mod, api, append, vault).
    // Shared by attest / grant / revoke so the wallet pops over the cockpit
    // for each.
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
        if (!w.length) {
          append("No Midnight wallet found. Install a Midnight wallet, unlock it, and check its network.");
          return;
        }
        var sVault = await this._vault();
        // Reuse the wallet chosen at sign-in when it is still injected: the user
        // already expressed the preference THIS session (in-memory only; the
        // localStorage variant was removed for good reason, see WalletPicker.js).
        // Any other case falls back to the picker, and a fresh pick is
        // remembered for the next action in the same session.
        var sKey = this._session().getProperty("/browserWalletKey") || "";
        if (!sKey || !w.some(function (x) { return x.key === sKey; })) {
          sKey = await WalletPicker.choose(w);
          this._session().setProperty("/browserWalletKey", sKey);
        }
        var oChosen = w.filter(function (x) { return x.key === sKey; })[0] || { name: sKey };
        append("connecting " + oChosen.name + ", approve the request in your wallet…");
        var api = await mod.connect(sKey);
        await fnRun(mod, api, append, sVault);
      } catch (e) {
        if (e && e.cancelled) { append("cancelled."); }
        else { append("ERROR: " + ((e && (e.stack || e.message)) || e)); }
      }
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
      if (!ph) { return this.toast("passport has no payloadHash yet, save it first"); }
      var that = this;
      // Fetch the content root (Merkle over the passport's provable fields) so
      // attest also anchors it, and the passportIdHash for the QR binding.
      // requestProperty forces passportIdHash into $select (it is not bound in
      // the view).
      Promise.all([
        this.callAction("/passportFieldValue", { passportId: this._pid(), sourceField: "carbonFootprintKgCO2" }),
        oCtx.requestProperty("passportIdHash")
      ]).then(function (aRes) {
        var contentRoot = (aRes[0] && aRes[0].contentRoot) || "";
        var pidHash = aRes[1] || "";
        that._lace("Attest with your wallet", async function (mod, api, append, vault) {
          // Batch path: a connector bundle with anchorBatch composes attest +
          // bindPassport + anchorContentRoot as ONE transaction (one wallet
          // approval), same call plan as the server's submitContractCallBatch
          // path. Feature-detected so a stale bundle keeps the proven
          // sequential flow (which has no bindPassport).
          if (typeof mod.anchorBatch === "function" && pidHash) {
            append("anchoring attest + bindPassport" + (contentRoot ? " + content root" : "") + " as ONE transaction (prove -> balance -> submit)…");
            await mod.anchorBatch(api, { contractAddress: vault, payloadHash: ph, metadataHash: ph, passportIdHash: pidHash, contentRoot: contentRoot }, append);
            var r = await that._resolveHash(mod, append);
            append("saving tx in cockpit…");
            await that.callAction("/recordWalletAttest", { passportId: that._pid(), txHash: r.hash, identifier: r.id, contractAddress: vault });
          } else {
            append("attesting the passport hash on-chain (prove -> balance -> submit)…");
            await mod.attest(api, { contractAddress: vault, payloadHash: ph, metadataHash: ph }, append);
            var r2 = await that._resolveHash(mod, append);
            append("saving tx in cockpit…");
            await that.callAction("/recordWalletAttest", { passportId: that._pid(), txHash: r2.hash, identifier: r2.id, contractAddress: vault });
            if (contentRoot) {
              append("anchoring content root (binds passport fields for field-bound proofs)…");
              await mod.anchorContentRoot(api, { contractAddress: vault, payloadHash: ph, contentRoot: contentRoot }, append);
              await that._resolveHash(mod, append);
            }
          }
          that._refreshAll(); append("done."); that.toast("attest via wallet saved");
        });
      }).catch(function (e) { that.error(e); });
    },

    onGrantWithLace: function () {
      var g = this.byId("granteePartner").getSelectedKey();
      if (!g) { return this.toast("select a partner"); }
      var lvl = parseInt(this.byId("grantLevel").getSelectedKey(), 10);
      var ph = this.getView().getBindingContext().getProperty("payloadHash") || "";
      if (!ph) { return this.toast("attest the passport with your wallet first"); }
      var that = this;
      this._lace("Grant with your wallet", async function (mod, api, append, vault) {
        append("granting disclosure level " + lvl + " on-chain…");
        await mod.grantDisclosure(api, { contractAddress: vault, payloadHash: ph, grantee: g, level: lvl }, append);
        var r = await that._resolveHash(mod, append);
        append("saving grant in cockpit…");
        await that.callAction("/recordWalletDisclosure", { passportId: that._pid(), grantee: g, level: lvl, op: "grant", txHash: r.hash });
        that._refreshAll(); append("done."); that.toast("grant via wallet saved");
      });
    },

    onRevokeWithLace: function () {
      var g = this.byId("granteePartner").getSelectedKey();
      if (!g) { return this.toast("select a partner"); }
      var ph = this.getView().getBindingContext().getProperty("payloadHash") || "";
      if (!ph) { return this.toast("attest the passport with your wallet first"); }
      var that = this;
      this._lace("Revoke with your wallet", async function (mod, api, append, vault) {
        append("revoking disclosure on-chain…");
        await mod.revokeDisclosure(api, { contractAddress: vault, payloadHash: ph, grantee: g }, append);
        var r = await that._resolveHash(mod, append);
        append("saving revoke in cockpit…");
        await that.callAction("/recordWalletDisclosure", { passportId: that._pid(), grantee: g, level: 0, op: "revoke", txHash: r.hash });
        that._refreshAll(); append("done."); that.toast("revoke via wallet saved");
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
      if (!sGrantee) { return this.toast("select the supplier partner"); }
      var lvl = parseInt(oShare.getProperty("/level"), 10);
      var ph = oShare.getProperty("/payloadHash") || "";
      if (!ph) { return this.toast("attest the passport with your wallet first"); }
      var that = this;
      this._lace("Grant supplier with your wallet", async function (mod, api, append, vault) {
        append("granting disclosure level " + lvl + " on-chain…");
        await mod.grantDisclosure(api, { contractAddress: vault, payloadHash: ph, grantee: sGrantee, level: lvl }, append);
        var r = await that._resolveHash(mod, append);
        append("saving grant in cockpit…");
        await that.callAction("/recordWalletDisclosure", { passportId: that._pid(), grantee: sGrantee, level: lvl, op: "grant", txHash: r.hash });
        that._refreshAll(); append("done."); that.toast("supplier granted via wallet");
      });
    },

    onCopyLink: function () {
      var sUrl = this.getView().getModel("share").getProperty("/resolveUrl");
      var that = this;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(sUrl).then(function () { that.toast("resolve link copied"); });
      } else { this.toast(sUrl); }
    },

    onDownloadCredential: function () {
      var that = this;
      // passportCredential is a function returning the credential JSON string
      // (the ProducerService variant is keyed by passportId).
      var oOp = this._model().bindContext("/passportCredential(...)");
      oOp.setParameter("passportId", this._pid());
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
