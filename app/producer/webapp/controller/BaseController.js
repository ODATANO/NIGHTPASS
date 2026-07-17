sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, MessageToast, MessageBox) {
  "use strict";

  return Controller.extend("producer.controller.BaseController", {

    // Render a guide-attribute valueJson fragment as readable text: scalars
    // as-is, {value, unit} pairs as "200 Ah", nested objects as key: value.
    formatAttrValue: function (sJson) {
      var v;
      try { v = JSON.parse(sJson); } catch (e) { return sJson || ""; }
      if (v === null || v === undefined) { return ""; }
      if (typeof v !== "object") { return String(v); }
      var aKeys = Object.keys(v);
      if (aKeys.length === 1) {
        var vOnly = v[aKeys[0]];
        return typeof vOnly === "object" ? JSON.stringify(vOnly) : String(vOnly);
      }
      var aNum = aKeys.filter(function (k) { return typeof v[k] === "number"; });
      var sUnit = aKeys.find(function (k) {
        return typeof v[k] === "string" && String(v[k]).length <= 14 && aNum.indexOf(k) < 0;
      });
      if (aNum.length === 1 && sUnit) { return v[aNum[0]] + " " + v[sUnit]; }
      return aKeys.map(function (k) {
        var val = v[k];
        return k + ": " + (typeof val === "object" ? JSON.stringify(val) : val);
      }).join(", ");
    },

    _model: function () { return this.getOwnerComponent().getModel(); },
    _session: function () { return this.getOwnerComponent().getModel("session"); },
    _router: function () { return this.getOwnerComponent().getRouter(); },

    setBusy: function (b) { this._session().setProperty("/busy", !!b); },

    toast: function (s) { MessageToast.show(s); },
    error: function (e) { MessageBox.error(String((e && (e.message || e.error && e.error.message)) || e)); },

    /**
     * Invoke an unbound OData v4 action (e.g. "/createPassport") with parameters,
     * returning the action result object. Shows a global busy state while running.
     */
    callAction: function (sPath, oParams) {
      var oModel = this._model();
      var oOp = oModel.bindContext(sPath + "(...)");
      Object.keys(oParams || {}).forEach(function (k) { oOp.setParameter(k, oParams[k]); });
      this.setBusy(true);
      var that = this;
      return oOp.invoke()
        .then(function () { return oOp.getBoundContext().getObject(); })
        .finally(function () { that.setBusy(false); });
    },

    // The cockpit's single-role auth header (same principal App.controller puts
    // on the OData model) for direct fetch calls: collection functions, polling.
    _authHeaders: function () {
      return { Authorization: "Basic " + window.btoa("producer:producer") };
    },

    explorerTx: function (sHash) {
      return sHash ? "https://preview.midnightexplorer.com/transactions/0x" + String(sHash).replace(/^0x/, "") : "";
    },

    // Formatter: submit is enabled until the passport is anchored.
    notAnchored: function (sStatus) { return sStatus !== "anchored"; }
  });
});
