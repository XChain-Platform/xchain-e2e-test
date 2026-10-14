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

const assert = require('assert');
const { ValidatorIdentity } = require('../../helpers/oracleBatchVenue');
const { eq } = require('./helpers/indexer_modules');
const { equivPrefixOf } = require('./helpers/signers');
const state = require('./helpers/state');
const { addTest } = require('./helpers/suite');

addTest('one real validator signed BOTH a per-round canonical and the batch canonical at one anchor', function () {
    const { parsed, batchCanonical, dual, canonicalFromSigningRound, rebuiltCanonical } = state;
    assert.ok(dual,
        'no validator could be shown to have signed both a per-round canonical and the batch ' +
        'canonical, so AT4\'s second half has no premise to test. The round signatures come from ' +
        'the round:finalized event and the batch signatures from the landed wire; an empty ' +
        'intersection means one of those sets is empty or verifies against different bytes.');
    // Producer and verifier agree on the batch bytes, on real data. Vacuous if the
    // signing round never handed over a canonical, so that is asserted first.
    assert.ok(canonicalFromSigningRound,
        'the batch canonical came from this file rebuilding it rather than from the signing round ' +
        'that actually produced it, so the producer/verifier equality below compares the indexer ' +
        'to itself');
    assert.strictEqual(dual.batchCanonical, rebuiltCanonical,
        'the hub\'s signing round and the indexer\'s buildPriceBatchPayload produced DIFFERENT ' +
        'canonical bytes for the same landed batch; every signature on the wire would fail on ' +
        'one side of that pair');
    assert.ok(ValidatorIdentity.verify(dual.roundCanonical, dual.roundSig, dual.pubkey),
        'the per-round signature does not verify over the per-round canonical');
    assert.ok(ValidatorIdentity.verify(dual.batchCanonical, dual.batchSig, dual.pubkey),
        'the batch signature does not verify over the batch canonical');
    // The tags, and the window inside the batch round id, are the whole defence.
    assert.ok(dual.roundCanonical.startsWith(
        'EQUIV|' + eq.ENGINE_TAGS.ORACLE + '|' + parsed.anchor + '|0||'),
        'the per-round canonical is not XORACLE-tagged at the anchor: ' + equivPrefixOf(dual.roundCanonical));
    assert.ok(dual.batchCanonical.startsWith(
        'EQUIV|' + eq.ENGINE_TAGS.ORACLE_BATCH + '|' + parsed.anchor + '|' + parsed.firstRound + '|' +
        parsed.lastRound + '|0||'),
        'the batch canonical is not XORACLEB-tagged with the window in its round id: ' +
        equivPrefixOf(dual.batchCanonical));
    assert.notStrictEqual(equivPrefixOf(dual.roundCanonical), equivPrefixOf(dual.batchCanonical),
        'the two canonicals share an EQUIV key prefix, which is exactly the collision the distinct ' +
        'engine tag exists to prevent');
}, __filename);
