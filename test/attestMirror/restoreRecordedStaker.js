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
