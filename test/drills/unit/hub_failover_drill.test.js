'use strict'

const assert = require('assert')
const { runHubFailoverDrill } = require('../lib/hubFailoverDrill')

function initialVenueState () {
    return {
        now: 0,
        stopped: false,
        moved: false,
        queued: null,
        mined: false,
        restarted: false,
        caughtUp: false,
    }
}

function venueHashes () {
    return {
        block_index: 102,
        ledger_hash: 'ledger', actions_hash: 'actions', contract_hash: 'contract', state_hash: 'state',
    }
}

function fakeIndexer (state, id, coin, role, pinned) {
    return {
        id, coin, role,
        followedHub: pinned ? 'hub-b' : (state.moved ? 'hub-b' : 'hub-a'),
        indexerBlock: state.mined ? 102 : 100,
        stallReason: null,
        hubMirror: { connected: true, bootstrapped: true, moveCount: pinned ? 0 : (state.moved ? 1 : 0) },
    }
}

function fakeSnapshot (state) {
    const queued = state.queued
    const survivorRows = queued ? { oracle_prices: [queued.rowKey] } : { oracle_prices: [] }
    const targetRows = state.caughtUp && queued ? { oracle_prices: [queued.rowKey] } : { oracle_prices: [] }
    return {
        hubs: [
            { id: 'hub-a', running: !state.stopped || state.restarted,
                caught_up: state.restarted ? state.caughtUp : !state.stopped,
                reports: state.caughtUp && queued ? [queued.reportId] : [], rows: targetRows },
            { id: 'hub-b', running: true, caught_up: true,
                reports: queued ? [queued.reportId] : [], rows: survivorRows },
        ],
        indexers: [
            fakeIndexer(state, 'btc', 'BTC', 'failover'), fakeIndexer(state, 'ltc', 'LTC', 'failover'),
            fakeIndexer(state, 'doge', 'DOGE', 'failover'),
            fakeIndexer(state, 'control', 'BTC', 'pinned-control', true),
        ],
    }
}

function observeVenue (state, overrides) {
    if (state.stopped && state.now >= 1000) state.moved = true
    if (state.restarted && state.now >= 2500) state.caughtUp = true
    const snapshot = fakeSnapshot(state)
    return overrides && overrides.transformObservation
        ? overrides.transformObservation(snapshot, { now: state.now })
        : snapshot
}

function fakeDriver (state, overrides) {
    const hashes = venueHashes()
    return {
        prepare: async () => ({ followedAddress: 'http://hub-a:10000' }),
        observe: async () => observeVenue(state, overrides),
        stopHub: async (id) => { assert.strictEqual(id, 'hub-a'); state.stopped = true; return { stopped: id } },
        queueReport: async () => {
            state.queued = { reportId: 'report-1', table: 'oracle_prices', rowKey: 'BTC:42' }
            return state.queued
        },
        mine: async (blocks) => { state.mined = true; return { blocks } },
        startHub: async (id) => {
            assert.strictEqual(id, 'hub-a')
            state.restarted = true
            if (overrides && overrides.firstReadyCaughtUp === true) state.caughtUp = true
            return { firstReady: { caught_up: !!(overrides && overrides.firstReadyCaughtUp) } }
        },
        blockHashes: async () => hashes,
    }
}

function fakeVenue (overrides) {
    const state = initialVenueState()
    const driver = fakeDriver(state, overrides)
    Object.assign(driver, overrides && overrides.driver)
    return {
        driver,
        clock: {
            now: () => state.now,
            sleep: async (ms) => { state.now += ms },
        },
    }
}

function registerHappyPathTests () {
    it('proves the move, catch-up, report fan-out, dwell, and four-hash parity', async function () {
        const venue = fakeVenue()
        const startHub = venue.driver.startHub
        let startCalls = 0
        venue.driver.startHub = async (id) => {
            startCalls++
            return startHub(id)
        }
        const evidence = await runHubFailoverDrill(venue.driver, {
            moveTimeoutMs: 2000, catchupTimeoutMs: 3000, blockTimeoutMs: 1000,
            dwellMs: 2000, pollMs: 100, clock: venue.clock,
        })
        assert.strictEqual(evidence.targetHub, 'hub-a')
        assert.strictEqual(evidence.survivingHub, 'hub-b')
        assert.strictEqual(evidence.moveElapsedMs, 1000)
        assert.strictEqual(evidence.parityHeight, 102)
        assert.ok(evidence.noFlapSamples > 0)
        assert.strictEqual(startCalls, 1)
    })
}

function registerFirstReadyTests () {
    it('accepts a caught_up first ready frame when the restarted hub already holds the outage row', async function () {
        const venue = fakeVenue({ firstReadyCaughtUp: true })
        const evidence = await runHubFailoverDrill(venue.driver, {
            moveTimeoutMs: 2000, catchupTimeoutMs: 3000, blockTimeoutMs: 1000,
            dwellMs: 0, pollMs: 100, clock: venue.clock,
        })
        assert.strictEqual(evidence.caughtUpElapsedMs, 0)
    })

    it('rejects a caught_up first ready frame when the restarted hub lacks the outage row', async function () {
        const venue = fakeVenue({
            driver: { startHub: async () => ({ firstReady: { caught_up: true } }) },
        })
        await assert.rejects(runHubFailoverDrill(venue.driver, {
            moveTimeoutMs: 2000, catchupTimeoutMs: 3000, blockTimeoutMs: 1000,
            dwellMs: 0, pollMs: 100, clock: venue.clock,
        }), /caught_up true before it held the outage row/)
    })
}

function registerRestartAndFlapTests () {
    it('prepares before observing and restarts the target after a drill failure', async function () {
        const calls = []
        const venue = fakeVenue()
        const observe = venue.driver.observe
        const startHub = venue.driver.startHub
        venue.driver.prepare = async () => { calls.push('prepare') }
        venue.driver.observe = async () => { calls.push('observe'); return observe() }
        venue.driver.queueReport = async () => { throw new Error('queue failed') }
        venue.driver.startHub = async (id) => { calls.push('start'); return startHub(id) }
        await assert.rejects(runHubFailoverDrill(venue.driver, {
            moveTimeoutMs: 2000, catchupTimeoutMs: 0, blockTimeoutMs: 0,
            dwellMs: 0, pollMs: 100, clock: venue.clock,
        }), /queue failed/)
        assert.strictEqual(calls[0], 'prepare')
        assert.strictEqual(calls.filter((call) => call === 'start').length, 1)
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
}

function registerParityAndAdvanceTests () {
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
}

describe('hub failover drill verdict', function () {
    registerHappyPathTests()
    registerFirstReadyTests()
    registerRestartAndFlapTests()
    registerParityAndAdvanceTests()
})
