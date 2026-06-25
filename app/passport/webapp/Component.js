sap.ui.define([
  "sap/ui/core/UIComponent",
  "passport/model/models"
], function (UIComponent, models) {
  "use strict";

  return UIComponent.extend("passport.Component", {
    metadata: { manifest: "json" },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);
      // Local session model: which disclosure tier is active and who, if anyone,
      // is logged in. The OData reads themselves are gated server-side by role.
      this.setModel(models.createSessionModel(), "session");
      this.getRouter().initialize();
    }
  });
});
