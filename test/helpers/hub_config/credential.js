/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict'

const XChainHubConnector = require('../../../src/XChainHubConnector')

// A redacted hub value is not a usable credential. An explicit environment
// value can supply it when discovery runs to fill another missing setting.
function hubCredential(hubValue, envValue, purpose) {
    if (hubValue !== XChainHubConnector.REDACTED) return hubValue
    if (envValue) return envValue
    return XChainHubConnector.assertUnredactedCredential(hubValue, purpose)
}

module.exports = { hubCredential }
