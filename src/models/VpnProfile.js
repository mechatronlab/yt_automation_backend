'use strict';

const { FirestoreModel } = require('../db/firestoreModel');
const GoogleAccount = require('./GoogleAccount');

const VpnProfile = new FirestoreModel('vpnProfiles', {
  populateMap: {
    googleAccount: GoogleAccount,
  },
});

module.exports = VpnProfile;
