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

const XChainHubConnector = require('../../../../src/XChainHubConnector');

function standingHubConnector() {
    if (global.hubConnector && global.hubConnector.urls && global.hubConnector.urls.length) {
        return global.hubConnector;
    }
    return new XChainHubConnector(XChainHubConnector.parseEndpoints());
}

function installStandingHubConnector() {
    const connector = standingHubConnector();
    // Preserve a connector the caller already selected and fill only the missing drive dependency.
    if (!global.hubConnector) global.hubConnector = connector;
    return connector;
}

module.exports = { installStandingHubConnector, standingHubConnector };
