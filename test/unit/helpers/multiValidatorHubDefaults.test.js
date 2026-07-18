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
 * Unit: MultiValidatorHub baked env defaults 
 *
 * The federation harness previously passed P2P_MAX_CONNECTIONS_PER_IP
 * straight through from the environment; unset, PeerManager's production
 * default (3) starved in-process meshes at N>4 (1 sig, no quorum).
 * These tests pin the baked default and its override precedence.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { MultiValidatorHub } = require('../../helpers/multiValidatorHubHelper.js');

describe('MultiValidatorHub baked env defaults ', function () {

    let savedEnv;
    beforeEach(function () { savedEnv = process.env.P2P_MAX_CONNECTIONS_PER_IP; });
    afterEach(function () {
        if (savedEnv === undefined) delete process.env.P2P_MAX_CONNECTIONS_PER_IP;
        else process.env.P2P_MAX_CONNECTIONS_PER_IP = savedEnv;
    });

    it('defaults P2P_MAX_CONNECTIONS_PER_IP to 64 with the env unset (default count 3)', function () {
        delete process.env.P2P_MAX_CONNECTIONS_PER_IP;
        const mvh = new MultiValidatorHub({});
        assert.strictEqual(mvh.p2pMaxConnectionsPerIp, 64);
    });

    it('scales the default with the mesh size for large counts', function () {
        delete process.env.P2P_MAX_CONNECTIONS_PER_IP;
        const mvh = new MultiValidatorHub({ count: 20 });
        assert.strictEqual(mvh.p2pMaxConnectionsPerIp, 80);
    });

    it('honours a numeric env override', function () {
        process.env.P2P_MAX_CONNECTIONS_PER_IP = '128';
        const mvh = new MultiValidatorHub({});
        assert.strictEqual(mvh.p2pMaxConnectionsPerIp, 128);
    });

    it('ignores a junk env value and falls back to the baked default', function () {
        process.env.P2P_MAX_CONNECTIONS_PER_IP = 'not-a-number';
        const mvh = new MultiValidatorHub({});
        assert.strictEqual(mvh.p2pMaxConnectionsPerIp, 64);
    });

    it('prefers an explicit opts value over env and default', function () {
        process.env.P2P_MAX_CONNECTIONS_PER_IP = '128';
        const mvh = new MultiValidatorHub({ p2pMaxConnectionsPerIp: 7 });
        assert.strictEqual(mvh.p2pMaxConnectionsPerIp, 7);
    });
});
