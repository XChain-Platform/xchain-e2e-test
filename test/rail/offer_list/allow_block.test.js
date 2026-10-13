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

// Offer-list leg: a SWAP offer carries an ALLOW_LIST and a BLOCK_LIST (address
// LISTs, wire fields 12 and 13). With both regtest switches armed on the venue, a
// counter-offer from an address on the allow list matches, and a counter-offer
// from an address on the block list is refused.
//
// The switches are the VENUE's opt-in, set in the shell that runs the suite and in
// the indexer containers' environment. This leg does not set them: arming the
// harness against an unarmed indexer would read a missing gate as a refusal.
//
// Stakes: this leg builds none. Every identity here is a funded address, so there
// is nothing for scripts/check-stake-teardown.js to release. A later edit that adds
// a STAKE must go through test/helpers/stakeHelper, which registers it for release.

const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const issueHelper = require('../../helpers/issueHelper')
const sendHelper = require('../../helpers/sendHelper')
const gasHelper = require('../../helpers/gasHelper')
const listHelper = require('../../helpers/listHelper')
const swapHelper = require('../../helpers/swapHelper')

const ARMING_ENV = ['XC_OFFER_LIST_REGTEST_ACTIVATION', 'EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME']
const ADDRESS_LIST = 2
const MATCH_WAIT_MS = 30000
const REFUSAL_WAIT_MS = 15000

describe('offer lists: allow and block on the regtest rail', function(){
    let maker, allowed, blocked, tokenA, tokenB, expiration

    before(async function(){
        const unset = ARMING_ENV.filter(name => !process.env[name])
        assert.deepStrictEqual(unset, [],
            'offer-list leg needs ' + unset.join(', ') + ' set in this shell and in the indexer '
            + 'containers; an unarmed venue ignores the lists and would read as a false pass')

        maker = await cryptoHelper.getNewFundedAddress('OFFERLIST.MAKER', COIN, NETWORK, null, 'legacy', 0, 1)
        allowed = await cryptoHelper.getNewFundedAddress('OFFERLIST.ALLOWED', COIN, NETWORK, null, 'legacy', 0, 1)
        blocked = await cryptoHelper.getNewFundedAddress('OFFERLIST.BLOCKED', COIN, NETWORK, null, 'legacy', 0, 1)
        const suffix = maker.address.substring(maker.address.length - 8)
        tokenA = 'OLSA' + suffix
        tokenB = 'OLSB' + suffix

        await issueHelper.sendIssueV0(maker, tokenA, 100, 50, 0, 'Offer list token A', 50)
        await issueHelper.sendIssueV0(maker, tokenB, 100, 50, 0, 'Offer list token B', 50)
        await sendHelper.sendSendV0(maker, tokenB, 20, allowed.address, 'Fund allowed taker')
        await sendHelper.sendSendV0(maker, tokenB, 20, blocked.address, 'Fund blocked taker')
        for(const party of [maker, allowed, blocked]) await gasHelper.ensureGasBalance(party, 100)
        expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
    })

    it('matches a counter-offer from an address on the allow list', async function(){
        const allowList = await listHelper.sendListV0(maker, ADDRESS_LIST, [allowed.address])
        const allowListIndex = Number(allowList.list.action_index)

        const offer = await swapHelper.sendSwapV0(maker, COIN_CODE, tokenA, 10, COIN_CODE, tokenB, 5,
            maker.address, expiration, allowListIndex, null, 'Allow-listed offer')
        const counter = await swapHelper.sendSwapV0(allowed, COIN_CODE, tokenB, 5, COIN_CODE, tokenA, 10,
            allowed.address, expiration, null, null, 'Counter from the allow list')

        const match = await indexerDatabase.waitForSwapMatch({
            giveActionIndex: Number(offer.swap.action_index),
            getActionIndex: Number(counter.swap.action_index),
            status: 'valid'
        }, MATCH_WAIT_MS)
        assert(match, 'the allow-listed counter-offer should match')
    })

    it('refuses a counter-offer from an address on the block list', async function(){
        const blockList = await listHelper.sendListV0(maker, ADDRESS_LIST, [blocked.address])
        const blockListIndex = Number(blockList.list.action_index)

        const offer = await swapHelper.sendSwapV0(maker, COIN_CODE, tokenA, 10, COIN_CODE, tokenB, 5,
            maker.address, expiration, null, blockListIndex, 'Block-listed offer')
        const counter = await swapHelper.sendSwapV0(blocked, COIN_CODE, tokenB, 5, COIN_CODE, tokenA, 10,
            blocked.address, expiration, null, null, 'Counter from the block list')

        const match = await indexerDatabase.waitForSwapMatch({
            giveActionIndex: Number(offer.swap.action_index),
            getActionIndex: Number(counter.swap.action_index),
            status: 'valid'
        }, REFUSAL_WAIT_MS).catch(() => null)
        assert(!match, 'the block-listed counter-offer must not match')

        const stillOpen = await indexerDatabase.waitForSwap({
            source: maker.address, giveTick: tokenA, swapStatus: 'complete'
        }, 1000).catch(() => null)
        assert(!stillOpen || Number(stillOpen.action_index) !== Number(offer.swap.action_index),
            'the offer that blocks the taker must not complete')
    })
})
