sap.ui.define([
  "sap/ui/core/mvc/Controller"
], function (Controller) {
  "use strict";

  return Controller.extend("producer.controller.App", {
    onInit: function () {
      // Single-role cockpit: authenticate as the mocked `producer` user so the
      // @requires:'producer' service reads/actions succeed without a login step.
      var oModel = this.getOwnerComponent().getModel();
      oModel.changeHttpHeaders({ Authorization: "Basic " + this._b64("producer:producer") });
      this.getOwnerComponent().getModel("session").setProperty("/authenticated", true);
    },

    _b64: function (s) {
      return window.btoa(unescape(encodeURIComponent(s)));
    }
  });
});
