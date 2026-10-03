'use strict'

const assert = require('assert')

const DEFAULT_MOVE_TIMEOUT_MS = 20000
const DEFAULT_CATCHUP_TIMEOUT_MS = 120000
const DEFAULT_BLOCK_TIMEOUT_MS = 60000
const DEFAULT_DWELL_MS = 120000
const DEFAULT_POLL_MS = 500
const HASH_FIELDS = Object.freeze(['ledger_hash', 'actions_hash', 'contract_hash', 'state_hash'])
const REQUIRED_COINS = Object.freeze(['BTC', 'DOGE', 'LTC'])

function numberSetting (value, fallback, name) {
    const parsed = value === undefined || value === '' ? fallback : Number(value)
    assert.ok(Number.isFinite(parsed) && parsed >= 0, name + ' must be a non-negative number')
    return parsed
}

function optionsFromEnv (env) {
    return {
        moveTimeoutMs: numberSetting(env.XCHAIN_HUB_FAILOVER_MOVE_TIMEOUT_MS,
            DEFAULT_MOVE_TIMEOUT_MS, 'XCHAIN_HUB_FAILOVER_MOVE_TIMEOUT_MS'),
        catchupTimeoutMs: numberSetting(env.XCHAIN_HUB_FAILOVER_CATCHUP_TIMEOUT_MS,
            DEFAULT_CATCHUP_TIMEOUT_MS, 'XCHAIN_HUB_FAILOVER_CATCHUP_TIMEOUT_MS'),
        blockTimeoutMs: numberSetting(env.XCHAIN_HUB_FAILOVER_BLOCK_TIMEOUT_MS,
            DEFAULT_BLOCK_TIMEOUT_MS, 'XCHAIN_HUB_FAILOVER_BLOCK_TIMEOUT_MS'),
        dwellMs: numberSetting(env.XCHAIN_HUB_FAILOVER_DWELL_MS,
            DEFAULT_DWELL_MS, 'XCHAIN_HUB_FAILOVER_DWELL_MS'),
        pollMs: numberSetting(env.XCHAIN_HUB_FAILOVER_POLL_MS,
            DEFAULT_POLL_MS, 'XCHAIN_HUB_FAILOVER_POLL_MS'),
    }
}

function byId (rows, id, kind) {
    const row = rows.find((candidate) => candidate.id === id)
    assert.ok(row, kind + ' observation missing for ' + id)
    return row
}

function normalizeSnapshot (snapshot) {
    assert.ok(snapshot && typeof snapshot === 'object', 'observe must return an object')
    assert.ok(Array.isArray(snapshot.hubs), 'observe.hubs must be an array')
    assert.ok(Array.isArray(snapshot.indexers), 'observe.indexers must be an array')
    assert.strictEqual(new Set(snapshot.hubs.map((hub) => hub.id)).size, snapshot.hubs.length,
        'hub ids must be unique')
    assert.strictEqual(new Set(snapshot.indexers.map((indexer) => indexer.id)).size, snapshot.indexers.length,
        'indexer ids must be unique')
    return snapshot
}

function mirrorReady (indexer) {
    return !!indexer.hubMirror && indexer.hubMirror.connected === true &&
        indexer.hubMirror.bootstrapped === true &&
        !(typeof indexer.stallReason === 'string' && /_barrier$/.test(indexer.stallReason))
}

function rowPresent (hub, table, key) {
    return !!hub.rows && Array.isArray(hub.rows[table]) && hub.rows[table].includes(key)
}

function reportPresent (hub, reportId) {
    return Array.isArray(hub.reports) && hub.reports.includes(reportId)
}

function validateBaseline (snapshot) {
    normalizeSnapshot(snapshot)
    assert.strictEqual(snapshot.hubs.length, 2, 'the failover venue must expose exactly two hubs')
    assert.strictEqual(snapshot.indexers.length, 4, 'the failover venue must expose exactly four indexers')
    const movable = snapshot.indexers.filter((indexer) => indexer.role === 'failover')
    const controls = snapshot.indexers.filter((indexer) => indexer.role === 'pinned-control')
    assert.deepStrictEqual(movable.map((indexer) => indexer.coin).sort(), [...REQUIRED_COINS].sort(),
        'the venue must expose one failover indexer for BTC, LTC and DOGE')
    assert.strictEqual(controls.length, 1, 'the venue must expose exactly one pinned control')
    assert.strictEqual(controls[0].coin, 'BTC', 'the pinned control must be a BTC indexer')
    assert.ok(snapshot.hubs.every((hub) => hub.running === true && hub.caught_up === true),
        'both hubs must start running and caught up')
    assert.ok(snapshot.indexers.every((indexer) => Number.isInteger(indexer.indexerBlock)),
        'every indexer must expose an integer indexerBlock')
    assert.ok(snapshot.indexers.every(mirrorReady), 'every indexer mirror must start connected and bootstrapped')

    const followed = new Set(movable.map((indexer) => indexer.followedHub))
    assert.strictEqual(followed.size, 1,
        'the three failover indexers must initially follow the same hub so one outage exercises all three')
    const target = movable[0].followedHub
    assert.ok(snapshot.hubs.some((hub) => hub.id === target), 'followed hub ' + target + ' is not in observe.hubs')
    const survivor = snapshot.hubs.find((hub) => hub.id !== target).id
    assert.strictEqual(controls[0].followedHub, survivor,
        'the pinned BTC control must follow the hub that survives the outage')
    return { movable, control: controls[0], target, survivor }
}

async function waitFor (read, predicate, timeoutMs, pollMs, clock, label) {
    const started = clock.now()
    let last
    do {
        last = await read()
        if (predicate(last)) return { value: last, elapsedMs: clock.now() - started }
        if (clock.now() - started >= timeoutMs) break
        await clock.sleep(Math.min(pollMs, Math.max(0, timeoutMs - (clock.now() - started))))
    } while (clock.now() - started <= timeoutMs)
    assert.fail(label + ' within ' + timeoutMs + 'ms; last observation: ' + JSON.stringify(last))
}

function assertMoved (snapshot, ids, survivor, baselineById) {
    normalizeSnapshot(snapshot)
    return ids.every((id) => {
        const current = byId(snapshot.indexers, id, 'indexer')
        const baseline = baselineById.get(id)
        return current.followedHub === survivor && mirrorReady(current) &&
            Number(current.hubMirror.moveCount) === Number(baseline.hubMirror.moveCount) + 1
    })
}

function assertHashParity (moved, control, height) {
    assert.strictEqual(Number(moved.block_index), height, 'moved BTC hashes are for the wrong height')
    assert.strictEqual(Number(control.block_index), height, 'control BTC hashes are for the wrong height')
    for (const field of HASH_FIELDS) {
        assert.ok(typeof moved[field] === 'string' && moved[field].length > 0,
            'moved BTC did not return ' + field)
        assert.ok(typeof control[field] === 'string' && control[field].length > 0,
            'control BTC did not return ' + field)
        assert.strictEqual(moved[field], control[field], field + ' differs at height ' + height)
    }
}

async function holdNoFlap (driver, ids, survivor, expectedMoveCounts, untilMs, pollMs, clock) {
    let samples = 0
    for (;;) {
        const snapshot = normalizeSnapshot(await driver.observe())
        for (const id of ids) {
            const indexer = byId(snapshot.indexers, id, 'indexer')
            assert.strictEqual(indexer.followedHub, survivor, id + ' flapped away from ' + survivor)
            assert.strictEqual(Number(indexer.hubMirror.moveCount), expectedMoveCounts.get(id),
                id + ' moved again inside the minimum dwell')
        }
        samples++
        if (clock.now() >= untilMs) return samples
        await clock.sleep(Math.min(pollMs, untilMs - clock.now()))
    }
}

async function runHubFailoverDrill (driver, rawOptions) {
    assert.ok(driver && typeof driver.observe === 'function', 'driver.observe is required')
    for (const method of ['stopHub', 'queueReport', 'mine', 'startHub', 'blockHashes'])
        assert.strictEqual(typeof driver[method], 'function', 'driver.' + method + ' is required')

    const options = Object.assign({
        moveTimeoutMs: DEFAULT_MOVE_TIMEOUT_MS,
        catchupTimeoutMs: DEFAULT_CATCHUP_TIMEOUT_MS,
        blockTimeoutMs: DEFAULT_BLOCK_TIMEOUT_MS,
        dwellMs: DEFAULT_DWELL_MS,
        pollMs: DEFAULT_POLL_MS,
        clock: { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    }, rawOptions || {})
    const clock = options.clock
    const baseline = normalizeSnapshot(await driver.observe())
    const venue = validateBaseline(baseline)
    const movableIds = venue.movable.map((indexer) => indexer.id)
    const baselineById = new Map(baseline.indexers.map((indexer) => [indexer.id, indexer]))
    const stoppedAt = clock.now()

    await driver.stopHub(venue.target)
    const stopped = normalizeSnapshot(await driver.observe())
    assert.strictEqual(byId(stopped.hubs, venue.target, 'hub').running, false,
        'target hub still reports running after stop')

    const movedWait = await waitFor(
        () => driver.observe(),
        (snapshot) => assertMoved(snapshot, movableIds, venue.survivor, baselineById),
        options.moveTimeoutMs, options.pollMs, clock, 'all failover indexers to move and certify their new hub')
    const moved = normalizeSnapshot(movedWait.value)
    const movedAt = clock.now()
    const expectedMoveCounts = new Map(movableIds.map((id) => [id,
        Number(byId(moved.indexers, id, 'indexer').hubMirror.moveCount)]))

    const queued = await driver.queueReport()
    assert.ok(queued && typeof queued.reportId === 'string' && queued.reportId,
        'queue-report must return a non-empty reportId')
    assert.ok(typeof queued.table === 'string' && queued.table, 'queue-report must return its mirrored table')
    assert.ok(typeof queued.rowKey === 'string' && queued.rowKey, 'queue-report must return its content rowKey')

    const survivingReport = await waitFor(
        () => driver.observe(),
        (snapshot) => {
            const hub = byId(normalizeSnapshot(snapshot).hubs, venue.survivor, 'hub')
            return reportPresent(hub, queued.reportId) && rowPresent(hub, queued.table, queued.rowKey)
        }, options.catchupTimeoutMs, options.pollMs, clock,
        'the outage report and its finalized row to reach the surviving hub')
    const beforeRestart = normalizeSnapshot(survivingReport.value)
    assert.strictEqual(rowPresent(byId(beforeRestart.hubs, venue.target, 'hub'), queued.table, queued.rowKey), false,
        'the stopped hub already held the outage row before restart')

    const preMineBlocks = new Map(beforeRestart.indexers.map((indexer) => [indexer.id, indexer.indexerBlock]))
    const mineResult = await driver.mine(2)
    assert.ok(mineResult && Number(mineResult.blocks) >= 2, 'mine must confirm at least two new blocks')
    const advancedWait = await waitFor(
        () => driver.observe(),
        (snapshot) => normalizeSnapshot(snapshot).indexers.every((indexer) =>
            mirrorReady(indexer) && indexer.indexerBlock > preMineBlocks.get(indexer.id)),
        options.blockTimeoutMs, options.pollMs, clock,
        'all mirrors to reopen their barriers and every indexer to advance')
    const advanced = normalizeSnapshot(advancedWait.value)

    const restart = await driver.startHub(venue.target)
    assert.ok(restart && restart.firstReady && Object.prototype.hasOwnProperty.call(restart.firstReady, 'caught_up'),
        'start-hub must capture the restarted hub first ready frame with caught_up')
    assert.strictEqual(restart.firstReady.caught_up, false,
        'the restarted hub first advertised ready with caught_up other than false')

    const caughtUpWait = await waitFor(
        () => driver.observe(),
        (snapshot) => {
            const hub = byId(normalizeSnapshot(snapshot).hubs, venue.target, 'hub')
            return hub.running === true && hub.caught_up === true &&
                reportPresent(hub, queued.reportId) && rowPresent(hub, queued.table, queued.rowKey)
        }, options.catchupTimeoutMs, options.pollMs, clock,
        'the restarted hub to catch up, receive the report, and hold the outage row')

    const noFlapSamples = await holdNoFlap(driver, movableIds, venue.survivor, expectedMoveCounts,
        movedAt + options.dwellMs, options.pollMs, clock)
    const finalSnapshot = normalizeSnapshot(await driver.observe())
    const movedBtc = finalSnapshot.indexers.find((indexer) =>
        indexer.role === 'failover' && indexer.coin === 'BTC')
    const control = byId(finalSnapshot.indexers, venue.control.id, 'indexer')
    const parityHeight = Math.min(movedBtc.indexerBlock, control.indexerBlock)
    assert.ok(Number.isInteger(parityHeight) && parityHeight >= 0, 'no common BTC parity height')
    const movedHashes = await driver.blockHashes(movedBtc.id, parityHeight)
    const controlHashes = await driver.blockHashes(control.id, parityHeight)
    assertHashParity(movedHashes, controlHashes, parityHeight)

    return {
        targetHub: venue.target,
        survivingHub: venue.survivor,
        initialFollowedHubs: Object.fromEntries(baseline.indexers.map((indexer) =>
            [indexer.id, indexer.followedHub])),
        moveElapsedMs: movedWait.elapsedMs,
        movedIndexers: movableIds,
        outageReport: queued,
        caughtUpElapsedMs: caughtUpWait.elapsedMs,
        blocksBefore: Object.fromEntries(preMineBlocks),
        blocksAfter: Object.fromEntries(advanced.indexers.map((indexer) =>
            [indexer.id, indexer.indexerBlock])),
        noFlapSamples,
        dwellMs: options.dwellMs,
        parityHeight,
        hashes: Object.fromEntries(HASH_FIELDS.map((field) => [field, movedHashes[field]])),
        stoppedAt,
    }
}

module.exports = {
    DEFAULT_MOVE_TIMEOUT_MS,
    DEFAULT_CATCHUP_TIMEOUT_MS,
    DEFAULT_BLOCK_TIMEOUT_MS,
    DEFAULT_DWELL_MS,
    HASH_FIELDS,
    optionsFromEnv,
    validateBaseline,
    runHubFailoverDrill,
}
