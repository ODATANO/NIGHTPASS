sap.ui.define([
  "sap/ui/core/UIComponent",
  "producer/model/models"
], function (UIComponent, models) {
  "use strict";

  return UIComponent.extend("producer.Component", {
    metadata: { manifest: "json" },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);
      this.setModel(models.createSessionModel(), "session");
      this.getRouter().initialize();
    }
  });
});
