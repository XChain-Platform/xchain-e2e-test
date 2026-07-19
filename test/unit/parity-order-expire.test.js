'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

//  guard: the multi-chain parity corpus must exercise time-based
// ORDER_EXPIRE deterministically. The live 3-chain sweep (multichain-parity.
// test.js) needs a running regtest stack, so this pure unit test locks the
// determinism CONTRACT the sweep relies on, catching a broken corpus without a
// stack:
//   1. exactly one deliberately-unmatchable ORDER, at UNMATCHABLE_ORDER_INDEX,
//      carrying the fixed ORDER_EXPIRE_AT expiration;
//   2. ORDER_EXPIRE_AT lands STRICTLY between two consecutive pinned block
//      times, so a later block is the first with block_time > expiration
//      (getExpiredItems: expiration < block_time) -> the expiry fires at one
//      identical block on every chain;
//   3. the order is BORN OPEN (its own block time < ORDER_EXPIRE_AT);
//   4. the matched orders + the DISPENSER use FAR_FUTURE, which stays above
//      every pinned block time AND under the decoder's Y2038 ceiling, so only
//      the unmatchable order ever expires;
//   5. pinned times are the fixed PIN_T0 + i*PIN_STEP schedule (identical
//      constants -> byte-identical block_time across chains), monotonic, and
//      PIN_T0 sits above the current wall-clock era (a forward jump).

const { expect } = require('chai');
const {
    FAR_FUTURE, PIN_T0, PIN_STEP, ORDER_EXPIRE_AT, UNMATCHABLE_ORDER_INDEX, corpus,
} = require('../parity/parityCorpus');

// The decoder's `dispensers.expiration` is a unixtime TIMESTAMP column; values
// above this truncate. FAR_FUTURE must stay under it (mirrors parityCorpus).
const Y2038_CEILING = 2147483647;
// A loose wall-clock floor: PIN_T0 must be a genuinely future timestamp so the
// jump off the real-time baseline is forward. 2026-01-01 UTC.
const WALLCLOCK_FLOOR = 1767225600;

describe('parity corpus ORDER_EXPIRE determinism contract ', function () {
    const steps = corpus('BTC');

    it('pins every step to the fixed PIN_T0 + i*PIN_STEP schedule (monotonic)', function () {
        expect(PIN_STEP).to.be.greaterThan(0);
        steps.forEach((s, i) => {
            expect(s.time, 'step ' + i + ' (' + s.label + ') missing/incorrect pinned time')
                .to.equal(PIN_T0 + i * PIN_STEP);
        });
        for (let i = 1; i < steps.length; i++) {
            expect(steps[i].time, 'pinned times must strictly increase').to.be.greaterThan(steps[i - 1].time);
        }
    });

    it('places PIN_T0 above the wall-clock era and the whole span below FAR_FUTURE', function () {
        expect(PIN_T0, 'PIN_T0 must be a future timestamp (forward jump off the real baseline)')
            .to.be.greaterThan(WALLCLOCK_FLOOR);
        const lastTime = steps[steps.length - 1].time;
        expect(lastTime, 'the last pinned block must stay below FAR_FUTURE so the dispenser survives')
            .to.be.lessThan(FAR_FUTURE);
        expect(FAR_FUTURE, 'FAR_FUTURE must stay under the decoder Y2038 ceiling')
            .to.be.at.most(Y2038_CEILING);
    });

    it('has exactly one unmatchable ORDER, at UNMATCHABLE_ORDER_INDEX, carrying ORDER_EXPIRE_AT', function () {
        const expiring = steps.filter(s => s.action === 'ORDER' && s.params.expiration === ORDER_EXPIRE_AT);
        expect(expiring.length, 'expected exactly one order with the ORDER_EXPIRE_AT expiration').to.equal(1);
        const step = steps[UNMATCHABLE_ORDER_INDEX];
        expect(step.action, 'UNMATCHABLE_ORDER_INDEX must point at the ORDER').to.equal('ORDER');
        expect(step.params.expiration, 'the indexed unmatchable order must carry ORDER_EXPIRE_AT')
            .to.equal(ORDER_EXPIRE_AT);
        // Genuinely unmatchable: no counter-order gives what it wants at its ratio.
        const counters = steps.filter(s => s.action === 'ORDER' &&
            s.params.giveTick === step.params.getTick &&
            s.params.getTick === step.params.giveTick &&
            s.params.getAmount === step.params.giveAmount);
        expect(counters.length, 'the unmatchable order must have no exact counter-order').to.equal(0);
    });

    it('crosses ORDER_EXPIRE_AT strictly between two consecutive pinned blocks', function () {
        // The expiry must fall in an open interval (t_k, t_{k+1}) so block k+1 is
        // the FIRST whose block_time exceeds it and no block lands exactly on it.
        const times = steps.map(s => s.time);
        const below = times.filter(t => t < ORDER_EXPIRE_AT);
        const above = times.filter(t => t > ORDER_EXPIRE_AT);
        expect(times.includes(ORDER_EXPIRE_AT),
            'no block may sit exactly on the expiration (strict < predicate would be ambiguous)').to.equal(false);
        expect(below.length, 'at least one block must precede the expiry').to.be.greaterThan(0);
        expect(above.length, 'at least one later block must cross the expiry').to.be.greaterThan(0);
        // The crossing block is the smallest pinned time above the expiration.
        const crossing = Math.min(...above);
        const priorGap = crossing - Math.max(...below);
        expect(priorGap, 'the crossing block must be the immediate successor of the last pre-expiry block')
            .to.equal(PIN_STEP);
    });

    it('the unmatchable order is born OPEN (its own block time is below the expiry)', function () {
        const step = steps[UNMATCHABLE_ORDER_INDEX];
        expect(step.time, 'the order must be placed before its expiration, not born expired')
            .to.be.lessThan(ORDER_EXPIRE_AT);
    });

    it('keeps the matched orders and the dispenser on FAR_FUTURE (they must not expire)', function () {
        const matched = steps.filter(s => s.action === 'ORDER' && s.params.expiration === FAR_FUTURE);
        expect(matched.length, 'the two matched counter-orders must use FAR_FUTURE').to.equal(2);
        const dispenser = steps.find(s => s.action === 'DISPENSER');
        expect(dispenser, 'corpus must include a DISPENSER').to.not.equal(undefined);
        expect(dispenser.params.expiration, 'the dispenser must use FAR_FUTURE').to.equal(FAR_FUTURE);
        // FAR_FUTURE stays above the block that crosses the unmatchable expiry, so
        // the dispenser survives the same expiry pass that expires the order.
        const crossing = Math.min(...steps.map(s => s.time).filter(t => t > ORDER_EXPIRE_AT));
        expect(FAR_FUTURE, 'FAR_FUTURE must exceed the expiry-crossing block time').to.be.greaterThan(crossing);
    });
});
