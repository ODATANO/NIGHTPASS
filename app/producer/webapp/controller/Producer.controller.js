sap.ui.define([
  "producer/controller/BaseController",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (BaseController, Fragment, JSONModel, Filter, FilterOperator) {
  "use strict";

  // Prefilled battery-passport example (EU 2023/1542 Annex XIII), editable in the
  // create dialog. Public Point-1 fields + the private (restricted) content.
  function defaultDraft() {
    return {
      passportId: "BAT-PROD-0001",
      manufacturerId: "DE-CELLCO-001",
      batteryCategory: "EV",
      model: "PowerCell EV-75",
      manufactureDate: "2026-03-15",
      weightKg: 432.5,
      performanceClass: "B",
      battery: {
        serialNumber: "SN-AX-0001",
        cellChemistry: "NMC-811",
        capacityKwh: 75.0,
        carbonFootprintKgCO2: 3412.75,
        supplierName: "CathodeWorks GmbH",
        recycledContentPct: 16.5,
        cycleLife: 4200,
        roundTripEfficiencyPct: 92.5,
        leadContentPpm: 45.0
      },
      recycled: [
        { material: "Co", recycledPercentage: 16.5, sourceSupplierName: "ReCobalt Recyclers SA" },
        { material: "Li", recycledPercentage: 8.25, sourceSupplierName: "LiLoop Recycling BV" },
        { material: "Ni", recycledPercentage: 12.0, sourceSupplierName: "NickelBack Materials Oy" }
      ],
      diligenceDocType: "supply-chain-due-diligence-report"
    };
  }

  return BaseController.extend("producer.controller.Producer", {

    onInit: function () {
      this._router().getRoute("main").attachPatternMatched(this._onMatched, this);
      this._applyOwnerFilter();
    },

    // Deep-linking to the list without a signing identity (e.g. a bookmarked
    // #/passports, or a reload) has nothing to scope the list to: back to login.
    _onMatched: function () {
      if (!this._session().getProperty("/connected")) {
        this._router().navTo("login", {}, true);
        return;
      }
      this._applyOwnerFilter();
    },

    // Runs before the list's first data load, so it never shows other producers'
    // passports (owner scope applied up front; empty until a signer is chosen).
    onBeforeRendering: function () {
      this._applyOwnerFilter();
    },

    onSwitchWallet: function () {
      this._router().navTo("login");
    },

    // Filter the passport list by the connected wallet owner; before connect,
    // a sentinel value keeps the list empty ("your" passports only).
    _applyOwnerFilter: function () {
      var oBinding = this.byId("passportTable").getBinding("items");
      if (!oBinding) { return; }
      var sOwner = this._session().getProperty("/owner");
      oBinding.filter(new Filter("owner", FilterOperator.EQ, sOwner || "__none__"));
      // Keep the header count in sync with the FILTERED binding (not the global
      // /Passports/$count, which would show every producer's passports).
      if (!this._countHooked) {
        this._countHooked = true;
        var that = this;
        oBinding.attachChange(function () { that._updatePassportCount(oBinding); });
      }
      this._updatePassportCount(oBinding);
    },

    _updatePassportCount: function (oBinding) {
      var n = 0;
      try {
        var oHeader = oBinding.getHeaderContext && oBinding.getHeaderContext();
        var v = oHeader && oHeader.getProperty("$count");
        n = (v == null) ? 0 : v;
      } catch (e) { n = 0; }
      this._session().setProperty("/passportCount", n);
    },

    onOpen: function (oEvent) {
      // Key from the binding PATH (always present), not getProperty("ID") which
      // can be undefined under autoExpandSelect. Path is "/Passports(<key>)".
      var oCtx = oEvent.getParameter("listItem").getBindingContext();
      var aMatch = oCtx && oCtx.getPath().match(/\(([^)]+)\)/);
      if (!aMatch) { return; }
      this._router().navTo("detail", { key: encodeURIComponent(aMatch[1]) });
    },

    onRefresh: function () {
      var oTable = this.byId("passportTable");
      if (oTable && oTable.getBinding("items")) { oTable.getBinding("items").refresh(); }
    },

    // ---- create ----

    onCreate: function () {
      if (!this._session().getProperty("/connected")) { return this.toast("connect your wallet first"); }
      var that = this;
      this.getView().setModel(new JSONModel(defaultDraft()), "create");
      if (!this._pCreate) {
        this._pCreate = Fragment.load({
          id: this.getView().getId(),
          name: "producer.fragment.CreatePassportDialog",
          controller: this
        }).then(function (oDialog) { that.getView().addDependent(oDialog); return oDialog; });
      }
      this._pCreate.then(function (oDialog) { oDialog.open(); });
    },

    onCreateCancel: function () {
      this.byId("createDialog").close();
    },

    // ---- register partner (self-service registry) ----

    onRegisterPartner: function () {
      var that = this;
      this.getView().setModel(new JSONModel({
        did: "BPNL000000000XYZ", name: "New Partner Co", role: "recycler", secret: "secret"
      }), "register");
      if (!this._pRegister) {
        this._pRegister = Fragment.load({
          id: this.getView().getId(),
          name: "producer.fragment.RegisterPartnerDialog",
          controller: this
        }).then(function (oDialog) { that.getView().addDependent(oDialog); return oDialog; });
      }
      this._pRegister.then(function (oDialog) { oDialog.open(); });
    },

    onRegisterCancel: function () {
      this.byId("registerDialog").close();
    },

    onRegisterSave: function () {
      var d = this.getView().getModel("register").getData();
      if (!d.did || !d.secret) { return this.toast("DID/BPN and secret are required"); }
      var that = this;
      this.setBusy(true);
      // registerPartner lives on PassportService (public self-service); call it
      // directly (the producer app is authenticated as the mocked producer).
      fetch("/api/v1/passport/registerPartner", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Basic " + window.btoa("producer:producer") },
        body: JSON.stringify({ did: d.did, name: d.name, role: d.role, secret: d.secret })
      }).then(function (r) {
        if (!r.ok) { return r.text().then(function (t) { throw new Error(t || ("HTTP " + r.status)); }); }
        return r.json();
      }).then(function (res) {
        that.byId("registerDialog").close();
        var oP = that.byId("partnersTable");
        if (oP && oP.getBinding("items")) { oP.getBinding("items").refresh(); }
        that.toast("partner registered: " + (res.name || res.did) + " · granteeId " + String(res.granteeId).slice(0, 10) + "…");
      }).catch(function (e) { that.error(e); })
        .finally(function () { that.setBusy(false); });
    },

    onCreateSave: function () {
      var d = this.getView().getModel("create").getData();
      var passportJson = JSON.stringify({
        passportId: d.passportId,
        manufacturerId: d.manufacturerId,
        batteryCategory: d.batteryCategory,
        model: d.model,
        manufactureDate: d.manufactureDate,
        weightKg: Number(d.weightKg),
        performanceClass: d.performanceClass,
        batteries: [{
          serialNumber: d.battery.serialNumber,
          cellChemistry: d.battery.cellChemistry,
          capacityKwh: Number(d.battery.capacityKwh),
          carbonFootprintKgCO2: Number(d.battery.carbonFootprintKgCO2),
          supplierName: d.battery.supplierName,
          recycledContentPct: Number(d.battery.recycledContentPct),
          cycleLife: Number(d.battery.cycleLife),
          roundTripEfficiencyPct: Number(d.battery.roundTripEfficiencyPct),
          leadContentPpm: Number(d.battery.leadContentPpm)
        }],
        recycledMaterials: (d.recycled || []).map(function (r) {
          return { material: r.material, recycledPercentage: Number(r.recycledPercentage), sourceSupplierName: r.sourceSupplierName };
        }),
        diligenceDocs: d.diligenceDocType ? [{ docType: d.diligenceDocType }] : []
      });

      var that = this;
      // Always save as an off-chain draft; anchoring happens wallet-driven
      // (Attest with Lace) in the detail cockpit.
      this.callAction("/createPassport", {
        passportJson: passportJson,
        submit: false,
        owner: this._session().getProperty("/owner")
      }).then(function (res) {
        that.byId("createDialog").close();
        that.onRefresh();
        that.toast("Passport " + res.passportId + " created (" + res.mode + ")");
      }).catch(function (e) { that.error(e); });
    }
  });
});
