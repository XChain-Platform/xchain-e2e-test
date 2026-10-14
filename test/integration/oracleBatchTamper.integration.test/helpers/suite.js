'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

const dotenv = require('dotenv');
dotenv.config();

const federation = require('./federation');
const artifacts = require('./artifacts');
const replay = require('./replay');
const report = require('./report');

// Boots the federation, lands the honest batch and the two tampers, reads both
// nodes, then drives the slash proofs. Each stage returns false when the venue is
// unavailable, in which case the whole suite skips.
async function setup(ctx) {
    if (!(await federation.startFederation())) { ctx.skip(); return; }
    if (!(await federation.publishHonestBatch())) { ctx.skip(); return; }
    await federation.landTampers();
    await federation.readLiveVerdicts();
    artifacts.captureArtifacts();
    await federation.stopFederation();

    if (!(await replay.startReplayNode())) { ctx.skip(); return; }
    await replay.replayChain();
    await replay.readLivePriceRows();
    replay.diffPriceRows();
    report.logEvidence();

    await artifacts.driveSlashProofs();
    report.logSlashDecisions();
}

// A real window, three chain landings, a whole node built from nothing and a
// full chain replay. The budget is per-suite; every wait inside is a poll that
// returns the moment its condition holds.
const sharedSuite = describe('AT4: a post-signing tamper is refused identically by two nodes, and an honest ' +
    'per-round + batch signer is NOT slashable (L3)', function () {
    this.timeout(90 * 60 * 1000);
    before(async function () { await setup(this); });
    after(federation.teardown);
});

function addTest(title, callback, file) {
    const test = new (require('mocha').Test)(title, callback);
    test.file = file;
    sharedSuite.addTest(test);
}

module.exports = { addTest };
