'use strict'

// Every test leaves a stateful regtest stack behind. Require an empty mempool
// and tracker height equal to node height before the next test begins. A stack
// that does not settle is a test failure, not a soft barrier warning, because
// dirty state can make the next test fail or pass for unrelated reasons.
// Fifteen seconds is generous for regtest; the detailed error retains tracker
// lag and failed mining nudges so an ordering-dependent failure is diagnosable.
// A clean stack normally reaches quiescence in less than one second, so the
// timeout indicates a real synchronization failure rather than routine load.
async function afterEachBarrier() {
    let status = null
    try {
        status = await utxoTrackerConnector.quiesce({
            timeoutMs: 15000, pollMs: 250, regtestMiner: regtestMinerConnector
        })
    } catch (error) {
        throw new Error('afterEach barrier: quiesce failed: ' +
            (error && error.message ? error.message : error))
    }
    if (status && status.ready) return
    const summary = status
        ? `mempool=${status.mempool_size} tracker=${status.tracker_height} node=${status.node_height} lag=${status.lag}`
        : 'no-response'
    const silent = status && status.noResponses ? ` noResponses=${status.noResponses}` : ''
    const mines = status && status.mineErrors
        ? ` nudgeMineFailures=${status.mineErrors} lastMineError=${status.lastMineError}` : ''
    throw new Error(`afterEach barrier: stack did not reach quiescence within 15s (${summary})${silent}${mines}`)
}

// Release fixture stakes before wiping wallet material because each UNSTAKE
// must be signed by the same source key as its STAKE. Strict teardown may turn
// a detected leak into an error after tests report, but cleanup still continues.
// The policy compares the final capability set with the beforeAll baseline and
// releases only entries attributable to the current test process.
async function releaseStake(config) {
    const { stakeTeardown, stakeHelper } = config
    await stakeTeardown.runTeardown({
        policy: global.stakeTeardownPolicy || undefined,
        baseline: global.stakeTeardownBaseline || null,
        indexer: global.indexerConnector || null,
        unstake: async (entry) => {
            if (entry.contractIndex !== null && entry.contractIndex !== undefined)
                await stakeHelper.sendUnstakeV1(
                    entry.addressInfo, entry.signingPubkey, entry.contractIndex, entry.tick)
            else await stakeHelper.sendUnstakeV0(entry.addressInfo, entry.signingPubkey)
        },
        // Read late-created connectors from global. A partial bootstrap must
        // preserve its original error instead of replacing it with a missing
        // lexical binding during cleanup.
        mine: async (count) => { await global.regtestMinerConnector.generateBlocks(count) },
        requireSync: async () => { await global.utxoTrackerConnector.requireSync() }
    })
}

function wipeWallets() {
    // Zero mutable key buffers before dropping references. Clearing only the
    // wallet map would leave seed and private-key bytes resident until garbage
    // collection decides to reclaim them.
    if (!global.wallets) return
    for (const label of Object.keys(global.wallets)) {
        const wallet = global.wallets[label]
        if (wallet.seed && Buffer.isBuffer(wallet.seed)) wallet.seed.fill(0)
        for (const address of wallet.addresses || [])
            if (address.privateKey && Buffer.isBuffer(address.privateKey)) address.privateKey.fill(0)
    }
    global.wallets = {}
}

async function closeIndexerPool() {
    // Pool closure is best-effort so a cleanup transport error cannot prevent
    // heartbeat restoration or replace a stricter stake-leak failure.
    try {
        if (global.indexerDatabase && global.indexerDatabase.pool)
            await global.indexerDatabase.pool.end()
    } catch (error) {
        console.log('There was a problem closing the database connection pool')
    }
}

async function teardownCore(config) {
    // Restore default block timing first, then release stake while signing keys
    // and the indexer pool still exist. Cleanup captures the stake error so key
    // erasure and pool closure always run before that error is rethrown.
    try { await regtestMinerConnector.setDefaultMiningTime() }
    catch (error) {
        console.log('There was a problem setting the default mining time values for the regtest miner')
    }
    let teardownError = null
    try { await releaseStake(config) }
    catch (error) { teardownError = error }
    wipeWallets()
    await closeIndexerPool()
    // Raise a strict stake error only after private keys are cleared and the
    // database pool is closed.
    if (teardownError) throw teardownError
}

async function afterAll(config) {
    // Preserve the first teardown error while still restoring miner heartbeat
    // baselines. Shared rails depend on that restoration even when this run has
    // already failed its leak check.
    let afterAllError = null
    try { await config.phase('teardown', () => teardownCore(config)) }
    catch (error) { afterAllError = error }
    const heartbeatFailures = await config.gasHelper.restoreHeartbeatBaselines()
    if (heartbeatFailures.length) {
        const heartbeatError = new Error('Could not restore regtest miner heartbeat baseline(s): ' +
            heartbeatFailures.join('; '))
        if (afterAllError) console.log(heartbeatError.message)
        else afterAllError = heartbeatError
    }
    if (afterAllError) throw afterAllError
}

module.exports = { afterEachBarrier, afterAll }
