'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.


const { classifySeatedForReseed, ALLOW_PREFIX_MIN_HEX } =
    require('./reseedAttestationRoster.test/helpers/reseed_attestation_roster')

module.exports = { classifySeatedForReseed, ALLOW_PREFIX_MIN_HEX }

require('./reseedAttestationRoster.test/01_seed_the_attestation_roster_on_a_reset_chain.test')
