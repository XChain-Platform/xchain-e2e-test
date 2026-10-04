'use strict'

const assert = require('assert')
const { runHubFailoverDrill } = require('../lib/hubFailoverDrill')

function fakeVenue (overrides) {
    let now = 0
    let stopped = false
    let moved = false
    let queued = null
    let mined = false
    let restarted = false
    let caughtUp = false
    const hashes = {
        block_index: 102,
        ledger_hash: 'ledger', actions_hash: 'actions', contract_hash: 'contract', state_hash: 'state',
    }
    function indexer (id, coin, role, pinned) {
        return {
            id, coin, role,
            followedHub: pinned ? 'hub-b' : (moved ? 'hub-b' : 'hub-a'),
            indexerBlock: mined ? 102 : 100,
            stallReason: null,
            hubMirror: { connected: true, bootstrapped: true, moveCount: pinned ? 0 : (moved ? 1 : 0) },
        }
    }

    function observe () {
        if (stopped && now >= 1000) moved = true
        if (restarted && now >= 2500) caughtUp = true
        const survivorRows = queued ? { oracle_prices: [queued.rowKey] } : { oracle_prices: [] }
        const targetRows = caughtUp && queued ? { oracle_prices: [queued.rowKey] } : { oracle_prices: [] }
        const snapshot = {
            hubs: [
                { id: 'hub-a', running: !stopped || restarted, caught_up: restarted ? caughtUp : !stopped,
                    reports: caughtUp && queued ? [queued.reportId] : [], rows: targetRows },
                { id: 'hub-b', running: true, caught_up: true,
                    reports: queued ? [queued.reportId] : [], rows: survivorRows },
            ],
            indexers: [
                indexer('btc', 'BTC', 'failover'), indexer('ltc', 'LTC', 'failover'),
                indexer('doge', 'DOGE', 'failover'), indexer('control', 'BTC', 'pinned-control', true),
            ],
        }
        return overrides && overrides.transformObservation
            ? overrides.transformObservation(snapshot, { now })
            : snapshot
    }

    const driver = {
        observe: async () => observe(),
        stopHub: async (id) => { assert.strictEqual(id, 'hub-a'); stopped = true; return { stopped: id } },
        queueReport: async () => {
            queued = { reportId: 'report-1', table: 'oracle_prices', rowKey: 'BTC:42' }
            return queued
        },
        mine: async (blocks) => { mined = true; return { blocks } },
        startHub: async (id) => {
            assert.strictEqual(id, 'hub-a')
            restarted = true
            return { firstReady: { caught_up: false } }
        },
        blockHashes: async () => hashes,
    }
    Object.assign(driver, overrides && overrides.driver)
    return {
        driver,
        clock: {
            now: () => now,
            sleep: async (ms) => { now += ms },
        },
    }
}

describe('hub failover drill verdict', function () {
    it('proves the move, catch-up, report fan-out, dwell, and four-hash parity', async function () {
        const venue = fakeVenue()
        const evidence = await runHubFailoverDrill(venue.driver, {
            moveTimeoutMs: 2000, catchupTimeoutMs: 3000, blockTimeoutMs: 1000,
            dwellMs: 2000, pollMs: 100, clock: venue.clock,
        })
        assert.strictEqual(evidence.targetHub, 'hub-a')
        assert.strictEqual(evidence.survivingHub, 'hub-b')
        assert.strictEqual(evidence.moveElapsedMs, 1000)
        assert.strictEqual(evidence.parityHeight, 102)
        assert.ok(evidence.noFlapSamples > 0)
    })

    it('fails if restart does not expose caught_up false in its first ready frame', async function () {
        const venue = fakeVenue({
            driver: { startHub: async () => ({ firstReady: { caught_up: true } }) },
        })
        await assert.rejects(runHubFailoverDrill(venue.driver, {
            moveTimeoutMs: 2000, catchupTimeoutMs: 3000, blockTimeoutMs: 1000,
            dwellMs: 0, pollMs: 100, clock: venue.clock,
        }), /caught_up other than false/)
    })

    it('fails on a transient flap while report and catch-up work is still running', async function () {
        const venue = fakeVenue({
            transformObservation: (snapshot, state) => {
                if (state.now >= 1500 && state.now < 2000) {
                    const btc = snapshot.indexers.find((indexer) => indexer.id === 'btc')
                    btc.followedHub = 'hub-a'
                    btc.hubMirror.moveCount = 2
                }
                return snapshot
            },
        })
        await assert.rejects(runHubFailoverDrill(venue.driver, {
            moveTimeoutMs: 2000, catchupTimeoutMs: 3000, blockTimeoutMs: 1000,
            dwellMs: 2000, pollMs: 100, clock: venue.clock,
        }), /btc flapped away from hub-b/)
    })

    it('fails when the moved BTC state hash differs from the pinned control', async function () {
        let reads = 0
        const venue = fakeVenue({
            driver: { blockHashes: async () => Object.assign({
                block_index: 102,
                ledger_hash: 'ledger', actions_hash: 'actions', contract_hash: 'contract',
                state_hash: ++reads === 1 ? 'moved-state' : 'control-state',
            }) },
        })
        await assert.rejects(runHubFailoverDrill(venue.driver, {
            moveTimeoutMs: 2000, catchupTimeoutMs: 3000, blockTimeoutMs: 1000,
            dwellMs: 0, pollMs: 100, clock: venue.clock,
        }), /state_hash differs/)
    })

    it('fails when mining succeeds but the indexers do not advance', async function () {
        const venue = fakeVenue({
            driver: { mine: async (blocks) => ({ blocks }) },
        })
        await assert.rejects(runHubFailoverDrill(venue.driver, {
            moveTimeoutMs: 2000, catchupTimeoutMs: 3000, blockTimeoutMs: 500,
            dwellMs: 0, pollMs: 100, clock: venue.clock,
        }), /every indexer to advance/)
    })
})
