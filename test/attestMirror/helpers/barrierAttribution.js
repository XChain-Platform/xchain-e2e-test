'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *********************************************************************/

const BARRIER_REASON = 'attest_response_sync_barrier'
const PARKED_CLASSES = ['barrier_defer', 'wedged', 'future_block_wait']

function isAttributedPark (status) {
    return Boolean(status &&
        status.reason === BARRIER_REASON &&
        PARKED_CLASSES.includes(status.klass))
}

module.exports = { BARRIER_REASON, PARKED_CLASSES, isAttributedPark }
