sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/base/Log"
], function (Controller, JSONModel, Log) {
  "use strict";

  /**
   * Public anchor explorer (showcase): lists every passport this demo issued
   * with its Midnight anchoring state (server function anchorExplorer, anchored
   * rows first) and verifies rows LIVE against the ledger via verifyOnChain.
   * Anonymous by design; exactly what a homepage visitor gets.
   */
  return Controller.extend("passport.controller.Explorer", {

    onInit: function () {
      this._model = new JSONModel({ rows: [], count: 0, busy: false, verifyingAll: false, serverNetwork: "", crossVerify: false });
      this.getView().setModel(this._model, "explorer");
      this.getOwnerComponent().getRouter().getRoute("explorer")
        .attachPatternMatched(this._load, this);
    },

    _load: function () {
      var oModel = this._model;
      oModel.setProperty("/busy", true);
      var pNetwork = fetch("/api/v1/passport/runtime-config")
        .then(function (oRes) { return oRes.json(); })
        .catch(function () { return {}; });
      var pRows = fetch("/api/v1/passport/anchorExplorer()")
        .then(function (oRes) {
          if (!oRes.ok) { throw new Error("anchorExplorer failed (" + oRes.status + ")"); }
          return oRes.json();
        });
      Promise.all([pNetwork, pRows])
        .then(function (aRes) {
          var sNet = aRes[0].network || "";
          // Cross-network rows are live-verifiable via the NIGHTGATE `network`
          // override (any network) or a delegating peer instance (listed ones).
          var bCrossVerify = aRes[0].crossNetworkVerify === true;
          var aPeers = aRes[0].peerNetworks || [];
          var aRows = (aRes[1].value || []).map(function (oRow) {
            oRow.verifying = false;
            var bCross = oRow.anchorNetwork && sNet && oRow.anchorNetwork !== sNet;
            oRow.verifiable = oRow.status === "anchored"
              && (!bCross || bCrossVerify || aPeers.indexOf(oRow.anchorNetwork) >= 0);
            // A cross-network row nothing can confirm here is said so up front
            // instead of offering a doomed check.
            oRow.verifyText = bCross && oRow.status === "anchored" && !oRow.verifiable
              ? "anchored on " + oRow.anchorNetwork : "";
            oRow.verifyState = "None";
            return oRow;
          });
          oModel.setProperty("/serverNetwork", sNet);
          oModel.setProperty("/crossVerify", bCrossVerify);
          oModel.setProperty("/rows", aRows);
          oModel.setProperty("/count", aRows.length);
        })
        .catch(function (oErr) {
          oModel.setProperty("/rows", []);
          oModel.setProperty("/count", 0);
          Log.error("explorer load failed: " + oErr);
        })
        .finally(function () { oModel.setProperty("/busy", false); });
    },

    onRefresh: function () { this._load(); },

    // ---- Live verification ----

    // Verify ONE row via the anonymous verifyOnChain function and write the
    // outcome back into the row (the table cells bind to these properties).
    _verifyRow: function (sPath) {
      var oModel = this._model;
      var sPid = oModel.getProperty(sPath + "/passportId");
      oModel.setProperty(sPath + "/verifying", true);
      oModel.setProperty(sPath + "/verifyText", "Checking...");
      oModel.setProperty(sPath + "/verifyState", "Information");
      var sUrl = "/api/v1/passport/verifyOnChain(passportId="
        + encodeURIComponent("'" + String(sPid).replace(/'/g, "''") + "'") + ")";
      return fetch(sUrl)
        .then(function (oRes) { return oRes.json(); })
        .then(function (oBody) {
          var bOk = oBody && oBody.verified === true;
          oModel.setProperty(sPath + "/verifyText", bOk ? "Verified on Midnight" : "Not confirmed");
          oModel.setProperty(sPath + "/verifyState", bOk ? "Success" : "Warning");
        })
        .catch(function () {
          oModel.setProperty(sPath + "/verifyText", "Check failed");
          oModel.setProperty(sPath + "/verifyState", "Error");
        })
        .finally(function () { oModel.setProperty(sPath + "/verifying", false); });
    },

    onVerifyRow: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("explorer");
      if (oCtx) { this._verifyRow(oCtx.getPath()); }
    },

    // Verify every anchored row, sequentially: one indexer read at a time keeps
    // the public endpoint polite and the row states tick green one by one. Rows
    // anchored on another network are skipped (their state already says so).
    onVerifyAll: function () {
      var that = this;
      var oModel = this._model;
      var aRows = oModel.getProperty("/rows") || [];
      var aPaths = [];
      aRows.forEach(function (oRow, i) {
        if (oRow.verifiable) { aPaths.push("/rows/" + i); }
      });
      if (!aPaths.length) { return; }
      oModel.setProperty("/verifyingAll", true);
      aPaths.reduce(function (pChain, sPath) {
        return pChain.then(function () { return that._verifyRow(sPath); });
      }, Promise.resolve())
        .finally(function () { oModel.setProperty("/verifyingAll", false); });
    },

    // ---- Formatters ----

    formatPassportLink: function (sPid) {
      return sPid ? "/p/" + encodeURIComponent(sPid) : "";
    },

    formatShortHash: function (sHash) {
      if (!sHash) { return ""; }
      return sHash.length > 20 ? sHash.slice(0, 10) + "..." + sHash.slice(-6) : sHash;
    },

    formatStatusState: function (sStatus) {
      switch (sStatus) {
        case "anchored":  return "Success";
        case "anchoring": return "Warning";
        case "failed":    return "Error";
        default:          return "None";
      }
    }
  });
});
