'use strict';

const {
    BRIDGE_CHAINS, DEFAULT_CONFIRMATIONS, DEFAULT_POLL_MS,
} = require('./constants');

/**
 * The extra environment the venue hubs need for their bridge engine.
 *
 * PURE. The three groups are three different obligations and conflating them is how a
 * venue boots looking healthy and finalizes nothing:
 *   <COIN>_INDEXER_URL  where the engine READS confirmed legs and chain state. Absent,
 *                       `CrossChainBridgeEngine.start()` idles with a logged reason and
 *                       the drive waits forever on a row no one is building.
 *   XCHAIN_CONFIRMATIONS_<TICK>  the depth a leg must reach before the engine will
 *                       propose it. coins.resolveConfirmations clamps an override back
 *                       UP to the per-coin default on mainnet and testnet, so this can
 *                       only ever lower a depth on regtest.
 *   XBRIDGE_POLL_MS     cadence only.
 *
 * @param {object} spec
 * @param {object} spec.indexerUrls   `{BTC: url, DOGE: url}`; a chain omitted is left unwired
 * @param {object} [spec.indexerKeys] `{BTC: key}` for an indexer that wants one
 * @param {object} [spec.confirmations] per-TICK depth; defaults to the rail's pinned 1
 * @param {number} [spec.pollMs]
 * @returns {object} a flat environment overlay
 */
function bridgeEngineHubEnv(spec) {
    const s = spec || {};
    const urls = s.indexerUrls || {};
    const keys = s.indexerKeys || {};
    const conf = Object.assign({}, DEFAULT_CONFIRMATIONS, s.confirmations || {});
    const env  = {};
    for (const chain of BRIDGE_CHAINS) {
        if (urls[chain]) env[chain + '_INDEXER_URL'] = String(urls[chain]);
        if (keys[chain]) env[chain + '_INDEXER_API_KEY'] = String(keys[chain]);
    }
    for (const tick of Object.keys(conf)) {
        const depth = Number(conf[tick]);
        if (!Number.isInteger(depth) || depth <= 0) {
            throw new Error('bridgeRailVenue: XCHAIN_CONFIRMATIONS_' + tick + '=' + conf[tick] +
                ' is not a positive integer. A non-integer depth parses to NaN in the hub and ' +
                'falls back to the per-coin default silently, so a drive that meant to pin 1 ' +
                'would wait the mainnet depth with nothing to say why.');
        }
        env['XCHAIN_CONFIRMATIONS_' + tick] = String(depth);
    }
    env.XBRIDGE_POLL_MS = String(s.pollMs === undefined ? DEFAULT_POLL_MS : s.pollMs);
    return env;
}

/**
 * The checkpoint cadence a venue federation must run for a bridge in leg to be PROVABLE.
 *
 * PURE, and this is the constraint that stalled the whole acceptance set on drive 8, so it
 * is written out in full. The destination's D2 cross-check will not mint against a
 * transfer without a quorum-established state checkpoint of the ORIGIN chain at or after
 * that transfer's `snapshot_block` (xchain-indexer/src/consensus/bridge_proof_client.js
 * `selectCheckpoint`, which requires `block_index >= snapshot_block`). Both numbers are
 * derived from the same BTC tip and both sit BELOW it:
 *
 *   the hub stamps    snapshot_block = tip - CANONICAL_REORG_BUFFER (6)
 *   the hub publishes checkpoints at  block_index = tip - CHECKPOINT_CONFIRMATIONS (6)
 *
 * so a checkpoint taken at the same moment as the transfer lands exactly one buffer SHORT
 * of qualifying, and only a checkpoint taken six or more blocks later can serve it. At the
 * shipped cadence (a round every CHECKPOINT_INTERVAL_BLOCKS = 6 BTC blocks) that is up to
 * twelve BTC blocks of waiting AFTER the relay margin, and on a regtest chain that mines
 * only when a transaction arrives it is a deadlock: the drive waits for blocks that only
 * the drive would produce. Measured 2026-09-12: transfer b743a79a snapshot_block 611, the
 * only quorum checkpoint block_index 605, and the destination deferred the block every five
 * seconds for half an hour with `no quorum-established checkpoint at or after the transfer
 * snapshot_block is held locally`.
 *
 * `CHECKPOINT_CONFIRMATIONS=0` is the seam the engine itself documents for this ("0 is
 * meaningful, checkpoint the tip itself, the regtest venue setting"), and it closes the gap
 * outright: a checkpoint at the tip is at or above every snapshot_block derived from it.
 * The interval and poll are lowered for the same reason a bridge poll is; neither changes a
 * verdict, only how soon a round is attempted.
 *
 * @param {object} [spec]
 * @param {number} [spec.pollMs]
 * @param {Array}  [spec.chains] chains to checkpoint; LTC is dropped by default because the
 *                 venue has no LTC indexer and every tick would log a skip for it
 * @returns {object}
 */
function venueCheckpointEnv(spec) {
    const s = spec || {};
    const chains = (s.chains || ['BTC', 'DOGE']).map((c) => String(c).toUpperCase());
    return {
        CHECKPOINT_ENABLED: 'true',
        CHECKPOINT_CONFIRMATIONS: '0',
        CHECKPOINT_INTERVAL_BLOCKS: '1',
        CHECKPOINT_POLL_MS: String(s.pollMs === undefined ? 5000 : s.pollMs),
        CHECKPOINT_CHAINS: chains.join(','),
        // AND NOTHING GOES ON CHAIN. A checkpoint round at every block would otherwise hand
        // StateAnchorPublisher an ANCHOR to broadcast on each chain it covers, from a venue
        // key that owns no coin, against the SHARED regtest chains every other rail lane's
        // fixtures hang off. The D2 proof reads the MIRRORED checkpoint, not an on-chain
        // anchor, so nothing this drive asserts needs the publication.
        ANCHOR_ENABLED: 'false',
    };
}

/**
 * The mirror-admission environment shared by every child in an armed venue.
 *
 * PURE. Admission ages each decoder tip by the round window of its table. Price uses
 * the oracle interval, whose default is 600000 ms, while list_snapshots and
 * bridge_transfers use the XDEX maximum lifetime, whose default is four 120000 ms
 * rounds. The one-minute oracle interval lowers the age assigned to price tips, and its
 * twenty-second submission window lets that round close inside the interval. Sampling
 * every five seconds makes a newly eligible tip visible promptly. The fifteen-second
 * XDEX timeout closes regtest rounds promptly, while its one-minute maximum lifetime
 * lowers the age assigned to list and bridge tips. The venue's existing 30000 ms
 * attestation round timeout is intentionally left unchanged.
 *
 * @param {*} raw mirror-admission activation, or an inert spelling
 * @returns {{hub: object, indexer: object}}
 */
function venueAdmissionEnv(raw) {
    const value = raw === undefined || raw === null ? '' : String(raw);
    const normalized = value.trim().toLowerCase();
    if (!normalized || ['off', 'inert', 'false', 'no', 'none'].includes(normalized)) {
        return { hub: {}, indexer: {} };
    }
    return {
        hub: {
            XC_MIRROR_ADMISSION_ACTIVATION: value,
            ORACLE_ROUND_INTERVAL: '60000',
            ORACLE_SUBMISSION_WINDOW: '20000',
            ADMISSION_WATERMARK_SAMPLE_MS: '5000',
            XDEX_ROUND_TIMEOUT_MS: '15000',
            XDEX_ROUND_MAX_LIFETIME_MS: '60000',
        },
        indexer: { XC_MIRROR_ADMISSION_ACTIVATION: value },
    };
}

/**
 * The environment overlay a venue INDEXER needs to fetch a D2 escrow proof.
 *
 * PURE. The destination indexer's settle pass resolves the origin chain's endpoint as
 * `<COIN>_INDEXER_API_URL` then `<COIN>_INDEXER_URL` then config
 * (xchain-indexer/src/consensus/bridge_proof_client.js `resolveOriginEndpoint`). With none of
 * them set every in leg raises BridgeProofUnavailableError and the block loop DEFERS
 * under `bridge_proof_barrier` rather than refusing, so the symptom of forgetting this
 * is a DOGE indexer that stops advancing at the transfer's block and never says
 * "misconfigured".
 *
 * @param {object} spec
 * @param {object} spec.indexerUrls  `{BTC: url}`; the origin chain's endpoint
 * @param {number} [spec.proofTimeoutMs]
 * @returns {object}
 */
function bridgeProofIndexerEnv(spec) {
    const s = spec || {};
    const urls = s.indexerUrls || {};
    const env = {};
    for (const chain of BRIDGE_CHAINS) {
        if (urls[chain]) env[chain + '_INDEXER_URL'] = String(urls[chain]);
    }
    if (s.proofTimeoutMs) env.BRIDGE_PROOF_TIMEOUT_MS = String(s.proofTimeoutMs);
    return env;
}

/**
 * The complete venue-wide environment for one destination indexer's bridge proofs.
 *
 * PURE. Admission and bridge proof wiring share AttestMirrorVenue's one
 * `indexerExtraEnv` slot, so every venue must compose them before assigning it. Returning
 * null for an empty overlay preserves AttestMirrorVenue's unset behavior.
 *
 * @param {object} spec
 * @param {object} [spec.indexerUrls] origin-chain endpoints
 * @param {object} [spec.admission] mirror-admission indexer environment
 * @returns {object|null}
 */
function bridgeVenueIndexerEnv(spec) {
    const s = spec || {};
    const env = Object.assign({}, bridgeProofIndexerEnv({
        indexerUrls: s.indexerUrls || {},
        proofTimeoutMs: s.proofTimeoutMs,
    }), s.admission || {});
    return Object.keys(env).length ? env : null;
}

module.exports = { bridgeEngineHubEnv, venueCheckpointEnv, venueAdmissionEnv, bridgeProofIndexerEnv, bridgeVenueIndexerEnv };
