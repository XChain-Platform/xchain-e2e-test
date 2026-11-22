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

async function restoreRecordedStaker(entry, { cryptoHelper, wallets, coin, network }) {
    delete wallets[entry.staker]

    let restored
    try {
        restored = await cryptoHelper.getNewAddress(
            entry.staker, coin, network, entry.mnemonic, 'legacy', 0)
    } finally {
        delete wallets[entry.staker]
    }

    if (String(restored.address) !== String(entry.address)) {
        const refused = 'restore produced ' + restored.address +
            ' rather than the recorded ' + entry.address
        return { refused }
    }

    return { restored }
}

module.exports = { restoreRecordedStaker }
