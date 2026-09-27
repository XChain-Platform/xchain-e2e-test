'use strict'

const assert = require('assert')

const { restoreRecordedStaker } = require('../../attestMirror/restoreRecordedStaker')

function createCryptoHelper(wallets) {
    return {
        async getWallet(label) {
            if (!(label in wallets)) wallets[label] = { mnemonic: null }
            return wallets[label]
        },

        async getNewAddress(label, coin, network, mnemonic, addressType, addressIndex) {
            assert.strictEqual(coin, 'bitcoin')
            assert.strictEqual(network, 'regtest')
            assert.strictEqual(addressType, 'legacy')
            assert.strictEqual(addressIndex, 0)

            const wallet = await this.getWallet(label)
            if (wallet.mnemonic === null) wallet.mnemonic = mnemonic
            return { address: 'address-for-' + wallet.mnemonic }
        }
    }
}

describe('restoreRecordedStaker', function () {
    it('restores each entry from its own mnemonic when the label is reused', async function () {
        const wallets = { shared: { mnemonic: 'stale' } }
        const cryptoHelper = createCryptoHelper(wallets)
        const dependencies = { cryptoHelper, wallets, coin: 'bitcoin', network: 'regtest' }
        const entries = [
            { staker: 'shared', mnemonic: 'first', address: 'address-for-first' },
            { staker: 'shared', mnemonic: 'second', address: 'address-for-second' }
        ]

        const first = await restoreRecordedStaker(entries[0], dependencies)
        assert.strictEqual(first.restored.address, entries[0].address)
        assert.ok(!('shared' in wallets))

        const second = await restoreRecordedStaker(entries[1], dependencies)
        assert.strictEqual(second.restored.address, entries[1].address)
        assert.ok(!('shared' in wallets))
    })

    it('refuses a mismatched address and removes the cached wallet', async function () {
        const wallets = {}
        const cryptoHelper = createCryptoHelper(wallets)
        const entry = { staker: 'shared', mnemonic: 'actual', address: 'address-for-expected' }

        const result = await restoreRecordedStaker(entry, {
            cryptoHelper,
            wallets,
            coin: 'bitcoin',
            network: 'regtest'
        })

        assert.ok(!result.restored)
        assert.match(result.refused, /address-for-actual/)
        assert.match(result.refused, /address-for-expected/)
        assert.ok(!('shared' in wallets))
    })
})
