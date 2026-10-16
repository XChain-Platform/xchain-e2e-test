'use strict'

async function pingServices(gasHelper) {
    // The node call gets a dedicated wrapper because transport exceptions and a
    // false response need one stable setup error. Other connectors normalize
    // transport failures into false readiness results.
    try {
        if (!await nodeConnector.getNetworkInfo()) throw new Error("Can't connect to the node")
    } catch (error) {
        console.log(error)
        throw new Error('There was an error trying to connect to the node')
    }
    if (!await utxoTrackerConnector.ping())
        throw new Error("Can't connect to the XChain Utxo Tracker module")
    if (!await encoderConnector.ping()) throw new Error("Can't connect to the XChain Encoder module")
    if (!await decoderConnector.ping()) throw new Error("Can't connect to the XChain Decoder module")
    if (!await indexerConnector.ping()) throw new Error("Can't connect to the XChain Indexer module")
    if (!await explorerConnector.ping()) throw new Error("Can't connect to the XChain Explorer module")
    if (!await indexerDatabase.ping()) throw new Error("Can't connect to the XChain Indexer Database")
    if (!await regtestMinerConnector.waitForReady())
        throw new Error("Can't connect to the XChain Regtest Miner module (not ready after wait)")
    // Pin heartbeat mining off before setting deterministic timing. Otherwise
    // background blocks can race deadline and confirmation assertions.
    await gasHelper.pinHeartbeatOff(regtestMinerConnector)
    await regtestMinerConnector.setMiningTime(1000, 1000)
}

async function seedNativePrices() {
    // Seed XCHAIN/USD and the native coin's USD price before the first action.
    // LTC and DOGE value native fee outputs against these prices, while gas-mode
    // BTC needs the native pair for USD-pegged contract fees. Action submission
    // refreshes prices during long runs so the oracle age limit is not crossed.
    // This early seed also prices the first ISSUE and GAS bootstrap action.
    //
    // Discover where the indexer reads prices before seeding. Hub database env
    // is only a model of indexer config, and an indexer-only HUB_DB_NAME can
    // redirect reads while fixtures still write to the indexer database. Both
    // databases remain healthy in that failure mode, but every priced action
    // rejects for lack of a current oracle price.
    // Discovery is best-effort so older indexers that omit priceSource retain the
    // environment model instead of blocking all setup.
    const topology = require('../helpers/hubMirrorTopology')
    await topology.discoverReadParams()
    const nativeFeeHelper = require('../helpers/nativeFeeHelper')
    await nativeFeeHelper.seedGlobalPrices(true)
}

async function captureStakeBaseline(stakeTeardown) {
    // Fixture stakes join the venue's real capability set. Capture its initial
    // membership before tests so teardown can leave it no larger than it began.
    // This avoids shared venues accumulating enough stale validators to put
    // checkpoint quorum out of reach. The read is best-effort: an indexer that
    // cannot answer still runs tests, but reports that leak checking is skipped.
    // Capture must happen before the first test creates any stake, otherwise the
    // teardown baseline would legitimize the very leak it is meant to detect.
    global.stakeTeardownPolicy = stakeTeardown.policy(process.env)
    global.stakeTeardownBaseline = await stakeTeardown.readCapabilitySet({
        indexer: indexerConnector,
        capability: global.stakeTeardownPolicy.capability
    })
    const baseline = global.stakeTeardownBaseline
    if (!baseline || baseline.error) {
        console.log('[stake teardown] baseline for ' + global.stakeTeardownPolicy.capability +
            ' unreadable' + (baseline && baseline.error ? ' (' + baseline.error + ')' : '') +
            ': the end-of-run leak check will not run')
    } else {
        console.log('[stake teardown] baseline: ' + baseline.pubkeys.length + ' key(s) / ' +
            baseline.sources.length + ' source(s) in ' + baseline.capability + ' at block ' + baseline.blockIndex)
    }
}

module.exports = { pingServices, seedNativePrices, captureStakeBaseline }
