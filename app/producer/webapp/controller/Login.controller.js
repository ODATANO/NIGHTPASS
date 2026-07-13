sap.ui.define([
  "producer/controller/BaseController",
  "sap/ui/model/json/JSONModel"
], function (BaseController, JSONModel) {
  "use strict";

  /**
   * Cockpit login: choose the SIGNING identity for this session.
   *
   *   wallet mode  the browser's Lace extension signs every tx (the user holds
   *                the keys); owner = the wallet's shielded address.
   *   server mode  NIGHTGATE signs on the server with one of the configured
   *                producer wallets (listServerWallets); owner = that wallet's
   *                shielded address, and its id travels as `walletId` on every
   *                on-chain action.
   *
   * Both modes end in the same place: session>/mode + /owner are set and the
   * passport list (scoped to that owner) opens. The detail cockpit dispatches
   * its Attest/Grant/Revoke/Prove buttons on the mode.
   */
  return BaseController.extend("producer.controller.Login", {

    onInit: function () {
      this.getView().setModel(new JSONModel({ mode: "", wallets: [] }), "login");
      this._router().getRoute("login").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function () {
      // Re-entering the login screen (switch wallet) resets the choice.
      this.getView().getModel("login").setData({ mode: "", wallets: [] });
      var oSession = this._session();
      oSession.setProperty("/connected", false);
      oSession.setProperty("/mode", "");
      oSession.setProperty("/walletId", "");
      oSession.setProperty("/owner", "");
      oSession.setProperty("/ownerShort", "");
    },

    onBack: function () {
      this.getView().getModel("login").setProperty("/mode", "");
    },

    // ---- browser wallet (Lace) ----

    onChooseLace: async function () {
      var oSession = this._session();
      try {
        this.setBusy(true);
        var mod = await import("/connector/lib/nightpass-connector.js");
        var aWallets = mod.listWallets();
        if (!aWallets.length) {
          return this.error("No Midnight wallet found. Install and unlock Lace on this network.");
        }
        var api = await mod.connect(aWallets[0].key);
        var addrs = await api.getShieldedAddresses();
        var sOwner = (addrs && (addrs.shieldedAddress || addrs.shieldedCoinPublicKey)) || "";
        if (!sOwner) { return this.error("wallet returned no address"); }
        this._enter("wallet", "", sOwner, "Lace");
      } catch (e) {
        this.error(e);
      } finally {
        this.setBusy(false);
      }
    },

    // ---- server wallets ----

    // `listServerWallets` is an OData FUNCTION returning a collection; those
    // cannot be read through bindContext().invoke() (that is for actions and
    // single-value functions), so fetch it directly. The cockpit's Basic auth
    // header is the same one App.controller puts on the OData model.
    onChooseServer: function () {
      var oLogin = this.getView().getModel("login");
      var that = this;
      this.setBusy(true);
      fetch("/api/v1/producer/listServerWallets()", {
        headers: { Authorization: "Basic " + window.btoa("producer:producer") }
      })
        .then(function (r) {
          if (!r.ok) { throw new Error("listServerWallets failed (" + r.status + ")"); }
          return r.json();
        })
        .then(function (b) {
          var a = (b.value || []).map(function (w) {
            var o = w.owner || "";
            return Object.assign({}, w, {
              ownerShort: o ? o.slice(0, 16) + "…" + o.slice(-6) : "no address configured"
            });
          });
          oLogin.setProperty("/wallets", a);
          oLogin.setProperty("/mode", "server");
        })
        .catch(function (e) { that.error(e); })
        .finally(function () { that.setBusy(false); });
    },

    onWalletSelect: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var oCtx = oItem.getBindingContext("login");
      if (!oCtx) { return; }
      var w = oCtx.getObject();
      if (!w.signingReady) {
        return this.error("Wallet '" + w.id + "' has no signing key configured on the server.");
      }
      if (!w.owner) {
        return this.error("Wallet '" + w.id + "' has no shielded address configured (PRODUCER_" +
          String(w.id).toUpperCase() + "_SHIELDED_ADDRESS); passports could not be scoped to it.");
      }
      this._enter("server", w.id, w.owner, w.label);
    },

    // ---- shared ----

    _enter: function (sMode, sWalletId, sOwner, sLabel) {
      var oSession = this._session();
      oSession.setProperty("/mode", sMode);
      oSession.setProperty("/walletId", sWalletId || "");
      oSession.setProperty("/owner", sOwner);
      oSession.setProperty("/ownerShort", sOwner.slice(0, 16) + "…" + sOwner.slice(-6));
      oSession.setProperty("/signerLabel", sLabel || sMode);
      oSession.setProperty("/connected", true);
      this.toast("signing as " + (sLabel || sMode));
      this._router().navTo("main");
    }
  });
});
