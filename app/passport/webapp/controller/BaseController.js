sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel"
], function (Controller, JSONModel) {
  "use strict";

  /**
   * Shared behaviour for the three tier views. Each view has a master List of
   * passports (id "passportList") and a detail container (id "detail"); selecting
   * a passport element-binds the detail to that row. The fields each view renders
   * differ per tier; the data they receive is already redacted server-side.
   */
  return Controller.extend("passport.controller.BaseController", {

    onPassportSelect: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var oCtx = oItem.getBindingContext();
      if (oCtx) { this._bindDetail(oCtx); }
    },

    _bindDetail: function (oCtx) {
      var oDetail = this.byId("detail");
      oDetail.bindElement({ path: oCtx.getPath() });
      oDetail.setVisible(true);
      var oEmpty = this.byId("emptyDetail");
      if (oEmpty) { oEmpty.setVisible(false); }
      // A verification result belongs to ONE passport; clear it on re-select.
      this._verifyModel().setData({ busy: false, text: "", state: "None", explorerUrl: "" });
    },

    // ---- Live on-chain verification (public) ----

    _verifyModel: function () {
      var oModel = this.getView().getModel("verify");
      if (!oModel) {
        oModel = new JSONModel({ busy: false, text: "", state: "None", explorerUrl: "" });
        this.getView().setModel(oModel, "verify");
      }
      return oModel;
    },

    // Calls the anonymous PassportService.verifyOnChain function, which asks the
    // Midnight indexer live whether the passport's payload hash is anchored in
    // the attestation vault. Works without login, exactly what a QR visitor has.
    onVerifyPassport: function () {
      var oCtx = this.byId("detail").getBindingContext();
      var sPid = oCtx && oCtx.getProperty("passportId");
      if (!sPid) { return; }
      var oModel = this._verifyModel();
      oModel.setData({ busy: true, text: "Checking the Midnight ledger...", state: "Information", explorerUrl: "" });
      var sUrl = "/api/v1/passport/verifyOnChain(passportId="
        + encodeURIComponent("'" + sPid.replace(/'/g, "''") + "'") + ")";
      fetch(sUrl)
        .then(function (oRes) {
          return oRes.json().then(function (oBody) { return { ok: oRes.ok, body: oBody }; });
        })
        .then(function (oRet) {
          if (!oRet.ok) {
            var sMsg = (oRet.body && oRet.body.error && oRet.body.error.message) || "Verification failed";
            throw new Error(sMsg);
          }
          var oBody = oRet.body;
          var sText, sState;
          if (oBody.verified) {
            sText = "Verified on Midnight" + (oBody.checkedNetwork ? " " + oBody.checkedNetwork : "")
              + ": the payload hash is anchored in the attestation vault.";
            sState = "Success";
          } else if (!oBody.checkedNetwork && oBody.anchorNetwork && oBody.serverNetwork
              && oBody.anchorNetwork !== oBody.serverNetwork) {
            sText = "Anchored on Midnight " + oBody.anchorNetwork + ". This host verifies against "
              + oBody.serverNetwork + ", so the live check cannot confirm it here; use the explorer link instead.";
            sState = "Warning";
          } else if (oBody.status === "anchored") {
            sText = "Anchored per record, but the live ledger read did not confirm it (indexer unreachable?). Try again.";
            sState = "Warning";
          } else {
            sText = "Not anchored on-chain yet (status: " + (oBody.status || "draft") + ").";
            sState = "Warning";
          }
          oModel.setData({ busy: false, text: sText, state: sState, explorerUrl: oBody.explorerUrl || "" });
        })
        .catch(function (oErr) {
          oModel.setData({ busy: false, text: String(oErr.message || oErr), state: "Error", explorerUrl: "" });
        });
    },

    // T23: when arriving via the QR resolver (?p=<passportId>), preselect that
    // battery as soon as the list has rendered. Consumed once.
    onListUpdateFinished: function () {
      var oSession = this.getOwnerComponent().getModel("session");
      var sPid = oSession.getProperty("/pendingPassport");
      if (!sPid) { return; }
      var oList = this.byId("passportList");
      var aItems = oList.getItems();
      for (var i = 0; i < aItems.length; i++) {
        var oCtx = aItems[i].getBindingContext();
        if (oCtx && oCtx.getProperty("passportId") === sPid) {
          oList.setSelectedItem(aItems[i]);
          this._bindDetail(oCtx);
          oSession.setProperty("/pendingPassport", "");
          break;
        }
      }
    },

    formatQrSrc: function (sPassportId) {
      return sPassportId ? "/qr/" + encodeURIComponent(sPassportId) + ".png" : "";
    },

    // ---- Formatters ----

    formatCategory: function (s) {
      switch (s) {
        case "EV":         return "Electric Vehicle";
        case "INDUSTRIAL": return "Industrial";
        case "LMT":        return "Light Means of Transport";
        default:           return s || "";
      }
    },

    formatPerfState: function (s) {
      if (!s) { return "None"; }
      return (s === "A" || s === "B") ? "Success" : (s === "C" || s === "D") ? "Warning" : "Error";
    },

    formatTxLink: function (sHash) {
      return sHash ? sHash : "not anchored";
    }
  });
});
