sap.ui.define([
  "sap/ui/model/json/JSONModel"
], function (JSONModel) {
  "use strict";

  return {
    /**
     * Client-side session state. `tier` mirrors the active route; `role`/`user`
     * track the mocked login used to lift the OData reads above the public tier.
     * The actual disclosure boundary is enforced server-side (PassportService
     * after-READ handlers). This model only drives the UI.
     */
    createSessionModel: function () {
      return new JSONModel({
        tier: "consumer",
        user: "",
        role: "",
        authenticated: false,
        pendingPassport: ""
      });
    }
  };
});
