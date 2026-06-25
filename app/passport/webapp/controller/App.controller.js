sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Fragment",
  "sap/m/MessageToast"
], function (Controller, Fragment, MessageToast) {
  "use strict";

  // Which mocked role each tier needs. consumer is anonymous (public reads).
  var TIER_ROLE = { consumer: null, recycler: "recycler", authority: "authority" };

  return Controller.extend("passport.controller.App", {

    onInit: function () {
      var oRouter = this.getOwnerComponent().getRouter();
      ["consumer", "recycler", "authority"].forEach(function (sTier) {
        oRouter.getRoute(sTier).attachPatternMatched(this._onRouteMatched.bind(this, sTier));
      }.bind(this));

      // T23: the QR resolver lands here as /...index.html?p=<passportId>#/<tier>.
      // Stash the passportId so each tier view preselects that battery once its
      // list has loaded (consumed once; see BaseController.onListUpdateFinished).
      var oParams = new URLSearchParams(window.location.search);
      var sPid = oParams.get("p");
      if (sPid) { this._session().setProperty("/pendingPassport", sPid); }
    },

    _session: function () {
      return this.getOwnerComponent().getModel("session");
    },

    _onRouteMatched: function (sTier) {
      this._session().setProperty("/tier", sTier);
      this.byId("sideNav").setSelectedKey(sTier);

      // Protected tier reached without a sufficient role → prompt sign-in.
      var sNeeded = TIER_ROLE[sTier];
      if (sNeeded && !this._hasRole(sNeeded)) {
        this._openLogin(sTier);
      }
    },

    _hasRole: function (sRole) {
      var oSession = this._session();
      if (!oSession.getProperty("/authenticated")) { return false; }
      // 'authority' is a superset of 'recycler' (see package.json mocked users).
      var sRole2 = oSession.getProperty("/role");
      if (sRole2 === "authority") { return true; }
      return sRole2 === sRole;
    },

    onNavSelect: function (oEvent) {
      var sKey = oEvent.getParameter("item").getKey();
      this.getOwnerComponent().getRouter().navTo(sKey);
    },

    // ---- Login ----

    onLoginPress: function () {
      if (this._session().getProperty("/authenticated")) {
        this._logout();
        return;
      }
      this._openLogin(this._session().getProperty("/tier"));
    },

    _openLogin: function (sTier) {
      var that = this;
      // Preselect the identity that satisfies the requested tier.
      var sUser = sTier === "authority" ? "authority" : "recycler";
      if (!this._pLogin) {
        this._pLogin = Fragment.load({
          id: this.getView().getId(),
          name: "passport.fragment.LoginDialog",
          controller: this
        }).then(function (oDialog) {
          that.getView().addDependent(oDialog);
          return oDialog;
        });
      }
      this._pLogin.then(function (oDialog) {
        that.byId("loginUser").setSelectedKey(sUser);
        that.byId("loginPass").setValue(sUser); // mocked: password == username
        oDialog.open();
      });
    },

    onLoginConfirm: function () {
      var sUser = this.byId("loginUser").getSelectedKey();
      var sPass = this.byId("loginPass").getValue();

      var oModel = this.getOwnerComponent().getModel();
      oModel.changeHttpHeaders({ Authorization: "Basic " + this._b64(sUser + ":" + sPass) });
      oModel.refresh();

      this._session().setData({
        tier: this._session().getProperty("/tier"),
        user: sUser,
        role: sUser, // mocked user name == its role
        authenticated: true
      });

      this.byId("loginDialog").close();
      MessageToast.show("Signed in as " + sUser);
    },

    onLoginCancel: function () {
      this.byId("loginDialog").close();
      // Cancelling a protected tier falls back to the public consumer view.
      if (!this._hasRole(TIER_ROLE[this._session().getProperty("/tier")] || "")) {
        this.getOwnerComponent().getRouter().navTo("consumer");
      }
    },

    _logout: function () {
      var oModel = this.getOwnerComponent().getModel();
      oModel.changeHttpHeaders({ Authorization: undefined });
      oModel.refresh();
      this._session().setData({ tier: "consumer", user: "", role: "", authenticated: false });
      this.getOwnerComponent().getRouter().navTo("consumer");
      MessageToast.show("Signed out");
    },

    _b64: function (s) {
      // UTF-8 safe base64 for the Basic auth header.
      return window.btoa(unescape(encodeURIComponent(s)));
    }
  });
});
