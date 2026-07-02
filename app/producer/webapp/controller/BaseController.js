sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, MessageToast, MessageBox) {
  "use strict";

  return Controller.extend("producer.controller.BaseController", {

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

    explorerTx: function (sHash) {
      return sHash ? "https://preview.midnightexplorer.com/transactions/0x" + String(sHash).replace(/^0x/, "") : "";
    },

    // Formatter: submit is enabled until the passport is anchored.
    notAnchored: function (sStatus) { return sStatus !== "anchored"; }
  });
});
