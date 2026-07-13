sap.ui.define([
  "sap/ui/model/json/JSONModel"
], function (JSONModel) {
  "use strict";

  return {
    createSessionModel: function () {
      // Producer cockpit is single-role: auto-authenticated as `producer`
      // (mocked auth). Tracks the busy state for long on-chain actions.
      return new JSONModel({
        user: "producer",
        authenticated: false,
        busy: false,
        connected: false,   // a signing identity was chosen on the login screen
        mode: "",           // 'wallet' (Lace, browser-signed) | 'server' (server wallet)
        walletId: "",       // server mode: which configured wallet signs
        signerLabel: "",    // display name of the chosen signer
        owner: "",          // shielded address = producer identity / owner scope
        ownerShort: ""
      });
    }
  };
});
