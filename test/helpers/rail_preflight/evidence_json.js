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

// Render drive evidence as JSON; RPC heights and amounts can arrive as BigInt, which
// JSON.stringify refuses, so each BigInt is written as its decimal string.
function bigintAsString(key, value){
    return typeof value === 'bigint' ? value.toString() : value
}

function evidenceJson(value, space){
    return JSON.stringify(value, bigintAsString, space)
}

module.exports = { bigintAsString, evidenceJson }
