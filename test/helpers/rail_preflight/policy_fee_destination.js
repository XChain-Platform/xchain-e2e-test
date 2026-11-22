// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const NOT_READY_MESSAGE = 'feeschedule not ready: empty fee destination'

function resolveDogeFeeDestination(schedule){
    if (schedule && schedule.nativeFeeEnabled === true &&
        typeof schedule.feeDestination === 'string' && schedule.feeDestination.length > 0) {
        return schedule.feeDestination
    }
    throw new Error(NOT_READY_MESSAGE)
}

module.exports = { resolveDogeFeeDestination }
