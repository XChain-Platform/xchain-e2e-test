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

const MS_PER_MINUTE = 60 * 1000

function limitSchedule (limitMinutes, graceMinutes = 20) {
    return {
        termAtMs: limitMinutes * MS_PER_MINUTE,
        killAtMs: (limitMinutes + graceMinutes) * MS_PER_MINUTE,
    }
}

function parseGraceMinutes (value) {
    const minutes = Number(value)
    if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error('teardown grace minutes must be a positive finite number: ' + String(value))
    }
    return minutes
}

module.exports = { limitSchedule, parseGraceMinutes }
