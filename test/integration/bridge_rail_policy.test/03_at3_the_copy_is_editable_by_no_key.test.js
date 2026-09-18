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
 **********************************************************************
 *
 * Policy AT3: a user LIST edit naming the materialized list on DOGE is refused
 * `invalid: LIST_ACTION_INDEX (bridge-owned)`; ISSUE format 5 by a user on the copy is refused
 * (keyless owner); a user SLEEP of the copy is refused.
 *
 * THE TWO STRINGS THE SPEC DOES NOT PIN. The ISSUE 5 refusal is the generic ownership check,
 * `invalid: issued by another address` (xchain-indexer src/actions/issue/token_state.js). The
 * SLEEP refusal the spec names `LOCK_SLEEP`, but the sleep handler refuses a non-owner FIRST,
 * with `invalid: TICK (not authorized)` (src/actions/sleep.js, the owner check precedes the
 * LOCK_SLEEP guard), so a user's SLEEP never reaches LOCK_SLEEP. The case asserts the handler's
 * strings and journals the spec's.
 *
 ********************************************************************/

'use strict';

const {
    POLICY_LIST_EDIT,
    listEditWire,
    policyListsWire,
    sleepTickWire,
} = require('../../helpers/bridgeRailVenue');
const {
    assert,
    state,
    dogeAction,
    fundDoge,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'policy AT3: the copy is editable by no key';

bridgeRailSuite(GROUP, function () {
    it('policy AT3: a user LIST edit of the materialized list, a user ISSUE 5 and a user SLEEP of the copy are each refused', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT3')) return;
        const M = state.policy.main;
        assert.ok(M.seq2, 'AT2 must have run');
        const copy = await state.venue.tokenParameters('DOGE', 'BTC.' + M.tick);
        assert.ok(copy && copy.params.block_list, 'BTC.' + M.tick + ' has no materialized BLOCK_LIST to attack');
        const user = await fundDoge('POLICY.AT3.USER', 5);
        const tip = Number((await state.venue.venueTips()).DOGE);
        const r = {};
        r.listEdit = await dogeAction(user, listEditWire(POLICY_LIST_EDIT.REMOVE, copy.params.block_list,
            [M.blocked2.address], 'policy AT3'), 'lists');
        r.issue5 = await dogeAction(user, policyListsWire('BTC.' + M.tick, null, '', 'policy AT3'), 'issues');
        r.sleep = await dogeAction(user, sleepTickWire('BTC.' + M.tick, tip + 1000, 'policy AT3'), 'sleeps');
        state.evidence.at3 = Object.assign({ specSleepString: 'invalid: LOCK_SLEEP' }, r);
        assert.strictEqual(r.listEdit.status, 'invalid: LIST_ACTION_INDEX (bridge-owned)', 'the user LIST edit graded ' + r.listEdit.status);
        assert.strictEqual(r.issue5.status, 'invalid: issued by another address', 'the user ISSUE 5 graded ' + r.issue5.status);
        assert.strictEqual(r.sleep.status, 'invalid: TICK (not authorized)', 'the user SLEEP graded ' + r.sleep.status);
        const after = await state.venue.indexerRpc('DOGE', 'gettokenpolicy',
            { tick: 'BTC.' + M.tick, origin_block: Number((await state.venue.venueTips()).DOGE) });
        assert.deepStrictEqual(after.block_list, [M.blocked2.address], 'the copy\'s block list moved to ' + JSON.stringify(after.block_list));
        assert.strictEqual(after.sleeping, false, 'the copy reads sleeping after a refused user SLEEP');
    });
});
