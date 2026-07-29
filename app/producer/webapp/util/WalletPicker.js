sap.ui.define([
  "sap/m/Dialog",
  "sap/m/List",
  "sap/m/StandardListItem",
  "sap/m/Button",
  "sap/m/Text"
], function (Dialog, List, StandardListItem, Button, Text) {
  "use strict";

  /**
   * Choosing WHICH Midnight wallet signs. Every time, with no default.
   *
   * The cockpit used to take `listWallets()[0]`: whichever extension happened to register on
   * `window.midnight` first. With one wallet installed that is invisible; with two it silently picks
   * one and the other is unreachable.
   *
   * An earlier version of this file remembered the choice in localStorage. That turned out worse than
   * no feature at all: reload an extension and, for the second it takes to re-inject, another wallet
   * is briefly the only one, which then became the permanent choice, and the picker never appeared
   * again. Persisting a preference the user never expressed is a bug wearing a convenience's clothes.
   *
   * So: always ask, including when only one wallet is present. One click, and which wallet is about to
   * sign is stated rather than assumed. Connecting still goes through the wallet's own approval.
   */

  return {
    /**
     * Resolve to the wallet key to connect with.
     *
     * @param {Array} aWallets result of the connector's `listWallets()`
     * @returns {Promise<string>} the chosen key; rejects if the user cancels
     */
    choose: function (aWallets) {
      if (!aWallets || !aWallets.length) {
        return Promise.reject(new Error("no Midnight wallet found in this browser"));
      }

      return new Promise(function (resolve, reject) {
        var bDecided = false;
        // Mode "None", NOT a selection mode: in a selection mode the tap is consumed by the list's
        // own selection handling and the item's `press` never fires; the dialog just sits there.
        var oList = new List({ mode: "None" });

        aWallets.forEach(function (w) {
          oList.addItem(new StandardListItem({
            title: w.name || w.key,
            // rdns identifies the wallet unambiguously where two share a display name.
            description: w.rdns || w.key,
            icon: w.icon || undefined,
            iconInset: false,
            type: "Active",
            press: function () {
              bDecided = true;
              oDialog.close();
              resolve(w.key);
            }
          }));
        });

        var oDialog = new Dialog({
          title: aWallets.length > 1 ? "Choose a wallet" : "Connect this wallet?",
          content: [
            new Text({
              text: "Each transaction still needs your approval in the wallet itself."
            }).addStyleClass("sapUiSmallMargin"),
            oList
          ],
          endButton: new Button({
            text: "Cancel",
            press: function () { oDialog.close(); }
          }),
          afterClose: function () {
            oDialog.destroy();
            if (!bDecided) {
              // Cancel is a decision, not a failure: callers check `cancelled` and
              // return quietly instead of surfacing an error dialog.
              var oCancel = new Error("wallet choice cancelled");
              oCancel.cancelled = true;
              reject(oCancel);
            }
          }
        });
        oDialog.open();
      });
    }
  };
});
