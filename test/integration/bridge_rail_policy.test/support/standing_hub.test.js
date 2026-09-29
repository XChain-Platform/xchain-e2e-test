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
 *********************************************************************/

'use strict';

const assert = require('assert');

const { standingHubConnector } = require('./standing_hub');

describe('policy rail standing hub connector', function () {
    let inherited;

    beforeEach(function () {
        inherited = global.hubConnector;
        delete global.hubConnector;
    });

    afterEach(function () {
        if (inherited === undefined) delete global.hubConnector;
        else global.hubConnector = inherited;
    });

    it('builds a configured connector when the global connector is unset', function () {
        const connector = standingHubConnector();
        assert.ok(Array.isArray(connector.urls));
        assert.ok(connector.urls.length > 0);
        assert.ok(connector.urls.every((url) => typeof url === 'string' && url.length > 0));
    });

    it('uses a populated global connector when one is available', function () {
        const connector = { urls: ['http://standing.example.test:1234'] };
        global.hubConnector = connector;
        assert.strictEqual(standingHubConnector(), connector);
    });
});
