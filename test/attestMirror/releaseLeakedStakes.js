'use strict'

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
 **********************************************************************
 * RELEASE the stakes a wedged teardown could not, from the keys it recorded.
 *
 * WHY THIS EXISTS. A drill's stake is not scratch state: it joins the venue's
 * REAL capability sets, and a leaked one dilutes the operator hub's weight share
 * and moves the venue toward a quorum it cannot reach. The automatic release runs
 * in the suite's root hook, and it fails for a reason that has nothing to do with
 * the stake: when the BTC indexer is wedged, nothing confirms at `status=valid`,
 * so the UNSTAKE broadcasts time out and the ones after them are never broadcast
 * at all. That is what happened on 2026-09-04, leaving five keys seated.
 *
 * The prologue records each staker's key material BEFORE broadcasting its stake,
 * exactly so that this is recoverable rather than permanent, and
 * `cryptoHelper.getNewAddress` takes a mnemonic, so the same label plus the
 * recorded mnemonic reconstructs the same address and its key. This walks that
 * path.
 *
 * NOT A `*.test.js` FILE, deliberately: the suite glob is `test/attestMirror/*.test.js`
 * and a repair tool must never be collected into an acceptance run. Drive it by
 * naming it:
 *
 *   npx mocha --no-config --timeout 0 --exit --require ./test/initialCheck.test.js \
 *     test/attestMirror/releaseLeakedStakes.js
 *
 * with `RELEASE_LABEL` naming the drill whose keys to release (default `at2b`).
 *
 * IT PRINTS THE BLOCK IT READ THE SET AT, and that is not decoration. An UNSTAKE
 * only STAMPS a deactivation block; the key leaves the EFFECTIVE set once that
 * block is both reached AND buried past the reorg buffer at which capability
 * snapshots resolve. So a re-read taken too early honestly reports a key still
 * seated whose release already succeeded, which is how a teardown comes to report
 * a leak it did not cause. This mines the settle distance, re-reads, and keeps
 * mining in bounded steps while any key is still seated, naming the height each
 * time.
 *
 * NO KEY MATERIAL IS EVER PRINTED. The recorded mnemonic is passed to the
 * restore and nothing else; the proof that the restore worked is that the
 * reconstructed address equals the recorded one.
 ********************************************************************/

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')
const dotenv = require('dotenv')
dotenv.config()

const cryptoHelper  = require('../cryptoHelper')
const stakeHelper   = require('../helpers/stakeHelper')
const stakeTeardown = require('../helpers/stakeTeardown')
const { DRILL_KEYS_DIR } = require('./mirrorDrillFixture')
const { mineBtcKeepingDogeAlive } = require('./mirrorDrillWaits')
const { clearWedgeIfPresent } = require('../helpers/stakeTeardown')

const LABEL = process.env.RELEASE_LABEL || 'at2b'

// Mined before the first re-read: the deactivation delay plus the burial the
// snapshot resolves at, which is what the teardown's own constant encodes.
const SETTLE_BLOCKS = Number(stakeTeardown.RELEASE_SETTLE_BLOCKS) || 14

// Then in steps, because the settle distance is a floor and not a guarantee: a
// release measured on this venue needed ten more blocks than the constant.
const EXTRA_STEP   = 10
const MAX_EXTRA    = 60

describe('release leaked stakes recorded by drill ' + LABEL, function () {
    this.timeout(90 * 60 * 1000)

    it('unstakes every recorded key and proves it left the capability set', async function () {
        const file = path.join(DRILL_KEYS_DIR, LABEL + '.json')
        if (!fs.existsSync(file)) {
            console.log('RELEASE SKIPPED: no recorded keys at ' + file);
            this.skip()
            return
        }
        const entries = JSON.parse(fs.readFileSync(file, 'utf8'))
        assert.ok(Array.isArray(entries) && entries.length > 0,
            'the recorded key file holds no entries, so there is nothing to release')
        console.log('RELEASE: ' + entries.length + ' recorded key(s) for ' + LABEL)

        // What the set holds BEFORE anything is released, so the effect is a
        // measured difference rather than an assumption.
        const before = await stakeTeardown.readCapabilitySet({ indexer: indexerConnector })
        assert.ok(before && !before.error,
            'could not read the capability set: ' + JSON.stringify(before))
        const mine = entries.map((e) => String(e.signingPubkey).toLowerCase())
        const seatedBefore = mine.filter((p) => before.pubkeys.includes(p))
        console.log('RELEASE: at block ' + before.blockIndex + ' the set holds ' + before.pubkeys.length +
            ' key(s), ' + seatedBefore.length + ' of them mine')

        // ---- broadcast one UNSTAKE per recorded key ------------------------
        const verdicts = []
        for (const entry of entries) {
            const short = String(entry.signingPubkey).slice(0, 16)
            if (!mine.includes(String(entry.signingPubkey).toLowerCase())) {
                verdicts.push({ pubkey: short, unstake: 'not seated, nothing to do' })
                continue
            }
            let restored = null
            try {
                // The mnemonic goes in here and nowhere else. Same label, type and
                // index as the prologue used, which is what makes it the same address.
                restored = await cryptoHelper.getNewAddress(
                    entry.staker, COIN, NETWORK, entry.mnemonic, 'legacy', 0)
            } catch (e) {
                verdicts.push({ pubkey: short, unstake: 'restore failed: ' + (e && e.message) })
                continue
            }
            if (String(restored.address) !== String(entry.address)) {
                // Refused rather than broadcast: an UNSTAKE signed by the wrong
                // address cannot release this stake and would only spend a fee.
                verdicts.push({ pubkey: short,
                    unstake: 'restore produced ' + restored.address + ' rather than the recorded ' + entry.address })
                continue
            }
            try {
                const res = await stakeHelper.sendUnstakeV0(restored, entry.signingPubkey)
                const status = res && res.unstake && res.unstake.status
                verdicts.push({ pubkey: short, address: entry.address, unstake: String(status) })
            } catch (e) {
                verdicts.push({ pubkey: short, address: entry.address,
                    unstake: 'broadcast failed: ' + (e && e.message) })
            }
        }
        console.log('RELEASE broadcasts:\n' + verdicts.map((v) =>
            '  ' + v.pubkey + '... ' + (v.address || '') + ' -> ' + v.unstake).join('\n'))

        // ---- settle, then re-read, then settle further if needed -----------
        // Keeping the other chain's tip alive as it goes: mining this many BTC blocks
        // with DOGE still is the exact recipe for the roll-call wedge, and a wedge here
        // is what turns a release into a leak.
        await mineBtcKeepingDogeAlive(SETTLE_BLOCKS)
        let mined = SETTLE_BLOCKS
        let current = await stakeTeardown.readCapabilitySet({ indexer: indexerConnector })
        let stillSeated = mine.filter((p) => current && current.pubkeys && current.pubkeys.includes(p))
        console.log('RELEASE: after ' + mined + ' block(s), at block ' +
            (current && current.blockIndex) + ', ' + stillSeated.length + ' of mine still seated')

        while (stillSeated.length > 0 && (mined - SETTLE_BLOCKS) < MAX_EXTRA) {
            // A FROZEN READ HEIGHT IS NOT A SEATED KEY. `readCapabilitySet` resolves
            // the set at the indexer's own tip, so a wedged indexer answers the same
            // stale question no matter how much is mined: measured here as 74 blocks
            // mined while every read came back at block 4051. Clearing between
            // operations is what makes the next read mean something, and without this
            // the loop burns its whole budget re-reading one stale height and then
            // reports a leak it cannot see past.
            const beforeHeight = current && current.blockIndex
            const clear = await clearWedgeIfPresent(console.log)
            if (clear.finding) console.log('RELEASE: ' + clear.reason)
            await mineBtcKeepingDogeAlive(EXTRA_STEP)
            mined += EXTRA_STEP
            current = await stakeTeardown.readCapabilitySet({ indexer: indexerConnector })
            stillSeated = mine.filter((p) => current && current.pubkeys && current.pubkeys.includes(p))
            const moved = current && current.blockIndex !== beforeHeight
            console.log('RELEASE: after ' + mined + ' block(s), at block ' +
                (current && current.blockIndex) + ' (' + (moved ? 'advancing' : 'HEIGHT DID NOT MOVE') +
                '), ' + stillSeated.length + ' of mine still seated')
        }

        assert.ok(current && !current.error,
            'could not re-read the capability set after settling: ' + JSON.stringify(current))
        console.log('RELEASE RESULT at block ' + current.blockIndex + ': the set holds ' +
            current.pubkeys.length + ' key(s), down from ' + before.pubkeys.length +
            '; ' + (seatedBefore.length - stillSeated.length) + ' of my ' + seatedBefore.length +
            ' released, ' + stillSeated.length + ' still seated' +
            (stillSeated.length ? ' (' + stillSeated.map((p) => p.slice(0, 16)).join(', ') + ')' : ''))

        assert.strictEqual(stillSeated.length, 0,
            stillSeated.length + ' of this drill\'s key(s) are STILL in the capability set at block ' +
            current.blockIndex + ' after ' + mined + ' settle blocks: ' +
            stillSeated.map((p) => p.slice(0, 16)).join(', ') +
            '. The broadcast verdicts above say whether the UNSTAKE was refused or simply has not ' +
            'settled; a refused one needs its reason read, and an unsettled one needs more blocks.')
    })
})
