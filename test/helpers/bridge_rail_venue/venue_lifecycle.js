'use strict';

const assert = require('assert');
const {
    bridgeEngineHubEnv, venueCheckpointEnv, bridgeVenueIndexerEnv,
} = require('./environment');
const { hubIndexerEnvMap, venueBtcIndexerCount } = require('./venue_helpers');

function buildVenueLifecycle(deps) {
const { AttestMirrorVenue, chainRail } = deps;

class VenueMethods {
    async start() {
        assert.ok(Array.isArray(this.identities) && this.identities.length >= 1,
            'bridgeRailVenue: identities are required. A venue on generated keys holds no stake, ' +
            'so its rounds time out at `0 commits` and the drive reads an engine fault where the ' +
            'real fact is an unstaked federation.');

        if (!this.btcRail && typeof chainRail.captureCurrentRail === 'function') {
            this.btcRail = chainRail.captureCurrentRail();
        }

        // PHASE 1: the hubs, and the BTC indexer that follows them. The bridge engine
        // constructs itself here with no indexer URLs and idles, which is exactly what it
        // should do on a hub that has none. See the header for why this cannot be one pass.
        this.btcVenue = new AttestMirrorVenue({
            label: this.label,
            coin: 'bitcoin',
            network: this.network,
            hubCount: this.identities.length,
            indexerCount: venueBtcIndexerCount(this.identities.length, this.btcIndexerPerHub, this.standingBtcIndexerUrl),
            identities: this.identities,
            basePort: this.basePort,
            // Undefined when unset, so attestMirrorVenue's own default still applies.
            repoRoot: this.repoRoot || undefined,
            // FROM BOOT, not from the rewire: the checkpoint engine starts with the hub, and
            // a transfer the engine finalizes before the rewire is stamped against a tip that
            // only a tip-height checkpoint can serve. See venueCheckpointEnv.
            hubExtraEnv: Object.assign({}, venueCheckpointEnv({}), this.admission.hub,
                // AND THE DISARM IS A DEPTH, not a missing URL. A venue hub already carries a
                // BTC indexer URL at boot for its other engines, so `deferBridgeWiring` alone
                // leaves the bridge engine free to finalize the rail's backlog while the
                // drive is still taking the two readings that must precede any in leg: on
                // drive 10 an XCHAIN row appeared on the destination ledger in the middle of
                // the AT9 before-witness, which the witness case caught and refused. Pinning
                // every depth out of reach idles the engine on a leg it can see but must not
                // sign yet, and `rewireHubs` replaces these with the rail's real pins the
                // moment the drive is ready. coins.resolveConfirmations only ever clamps an
                // override UP off regtest, so this can never loosen a depth anywhere.
                this.deferBridgeWiring ? {
                    XCHAIN_CONFIRMATIONS_BTC:  '1000000',
                    XCHAIN_CONFIRMATIONS_DOGE: '1000000',
                    XCHAIN_CONFIRMATIONS_LTC:  '1000000',
                } : {}),
            indexerExtraEnv: bridgeVenueIndexerEnv({ admission: this.admission.indexer }),
            // The proof client and the settle pass both live on the block-processing path,
            // so an indexer barrier that stays shut parks the block. Every grace at 0 is
            // the venue default and is what the attest drills already rely on.
            graces: {},
        });
        const btcUp = await this.btcVenue.start();
        if (!btcUp) { this.unavailable = this.btcVenue.unavailable; return false; }

        // PHASE 2: the DOGE indexer, attached to the SAME hubs and sharing their hub
        // database. Started INSIDE the DOGE rail so the chain-database clone reads the
        // standing DOGE node and the decoder discovered is DOGE's; the attest mirror
        // venue's own AT5 drill established that shape.
        const rail = this.dogeRail || await chainRail.createRail('dogecoin', this.network);
        this.dogeRail = rail;
        this.dogeVenue = await chainRail.withRail(rail, async () => {
            const dv = new AttestMirrorVenue({
                label: this.label + 'doge',
                coin: 'dogecoin',
                network: this.network,
                attachHubs: this.btcVenue.hubs,
                hubDb: this.btcVenue.hubDb,
                indexerCount: 1,
                // The harness DECODER_DB_* describe Bitcoin; this venue's decoder is DOGE's.
                useEnvDecoderCredential: false,
                basePort: this.basePort + 200,
                graces: {},
                // Same tree as the BTC half: this venue spawns the DOGE indexer.
                repoRoot: this.repoRoot || undefined,
                // See the constructor: AT1's precondition is a property of the ledger this
                // indexer builds, not of the chain, and only a replay builds the one AT1
                // describes.
                replayChain: this.dogeReplayChain,
                // The hubs this venue attaches to were seeded for BITCOIN, so DOGE/USD is
                // whatever the venue oracle published for it (about 0.085) and the tip
                // barrier's one BTC-sized sanity band rejects that. Seed the pair here,
                // which is also what a standalone DOGE venue does for itself, so both DOGE
                // indexers in a rail drive price DOGE actions the same way.
                seedAttachedHubPrices: true,
                // The D2 escrow-proof client runs on the DESTINATION indexer and fetches
                // `getbridgeescrowproof` from the ORIGIN chain's endpoint. The BTC venue
                // indexer exists by now, which is the other half of why bring-up is
                // ordered the way it is.
                indexerExtraEnv: bridgeVenueIndexerEnv({
                    indexerUrls: { BTC: this.btcIndexerUrl() },
                    admission: this.admission.indexer,
                }),
            });
            const ok = await dv.start();
            if (!ok) return { failed: dv.unavailable };
            return dv;
        });
        if (this.dogeVenue && this.dogeVenue.failed) {
            this.unavailable = 'the attached DOGE venue did not start: ' + this.dogeVenue.failed;
            this.dogeVenue = null;
            return false;
        }

        // PHASE 3: the optional LTC indexer, built in the Litecoin rail and attached to
        // the same hubs and hub database as the other two venue indexers.
        if (this.withLtc) {
            const ltcRail = this.ltcRail || await chainRail.createRail('litecoin', this.network);
            this.ltcRail = ltcRail;
            this.ltcVenue = await chainRail.withRail(ltcRail, async () => {
                const lv = new AttestMirrorVenue({
                    label: this.label + 'ltc',
                    coin: 'litecoin',
                    network: this.network,
                    attachHubs: this.btcVenue.hubs,
                    hubDb: this.btcVenue.hubDb,
                    indexerCount: 1,
                    useEnvDecoderCredential: false,
                    basePort: this.basePort + 400,
                    graces: {},
                    repoRoot: this.repoRoot || undefined,
                    replayChain: true,
                    seedAttachedHubPrices: true,
                    indexerExtraEnv: bridgeVenueIndexerEnv({
                        indexerUrls: { BTC: this.btcIndexerUrl(), DOGE: this.dogeIndexerUrl() },
                        admission: this.admission.indexer,
                    }),
                });
                const ok = await lv.start();
                if (!ok) return { failed: lv.unavailable };
                return lv;
            });
            if (this.ltcVenue && this.ltcVenue.failed) {
                this.unavailable = 'the attached LTC venue did not start: ' + this.ltcVenue.failed;
                this.ltcVenue = null;
                return false;
            }
        }

        // PHASE 4: the BTC indexers could not know their origin endpoints at boot: DOGE
        // and optional LTC are constructed after them. Restart them now with the complete
        // proof environment before any caller can submit a DOGE->BTC or LTC->BTC in leg.
        await this.wireBtcIndexerProofs();

        // PHASE 5: rewire. Every hub is restarted carrying the venue indexer URLs, so
        // its bridge engine polls the BTC indexer for confirmed locks and the DOGE indexer
        // for the destination's chain state. Deferred when the caller says so; see
        // `deferBridgeWiring` for the reading that has to happen first.
        if (!this.deferBridgeWiring) await this.rewireHubs();
        else if (Object.keys(this.admission.hub).length) await this.wireAdmissionTips();

        return true;
    }

    /**
     * Restart every BTC venue indexer with the late-built origin-chain endpoints.
     */
    async wireBtcIndexerProofs() {
        assert.ok(this.btcVenue, 'bridgeRailVenue: wireBtcIndexerProofs before start');
        const overlay = bridgeVenueIndexerEnv({
            indexerUrls: { DOGE: this.dogeIndexerUrl(), LTC: this.ltcIndexerUrl() },
            admission: this.admission.indexer,
        });
        this.btcVenue.indexerExtraEnv = overlay;
        for (const ix of this.btcVenue.indexers) {
            await this.btcVenue['_kill'](ix.proc);
            ix.proc = null;
            ix.connector = null;
            await this.btcVenue['_spawnIndexer'](ix.index);
        }
        return overlay;
    }

    /**
     * Restart armed, deferred hubs with admission tip URLs but keep bridge depths pinned.
     */
    async wireAdmissionTips() {
        assert.ok(this.btcVenue, 'bridgeRailVenue: wireAdmissionTips before start');
        const overlay = {};
        if (this.dogeIndexerUrl()) overlay.DOGE_INDEXER_URL = this.dogeIndexerUrl();
        if (this.ltcIndexerUrl()) overlay.LTC_INDEXER_URL = this.ltcIndexerUrl();
        this.btcVenue.hubExtraEnv = Object.assign({}, this.btcVenue.hubExtraEnv || {}, overlay);
        for (const hub of this.btcVenue.hubs) {
            await this.btcVenue.stopHub(hub.index);
            await this.btcVenue.startHub(hub.index);
        }
        return overlay;
    }

    /**
     * Restart every hub with the bridge engine pointed at the venue indexers.
     *
     * Exposed rather than private because AT2's second run re-pins DOGE's depth at 60 and
     * has to make the federation read the new value, and a drive that reached into
     * `hubExtraEnv` and restarted hubs by hand would be reimplementing this.
     *
     * @param {object} [confirmations] a new per-TICK depth map, merged over the venue's
     */
    async rewireHubs(confirmations) {
        assert.ok(this.btcVenue, 'bridgeRailVenue: rewireHubs before start');
        if (confirmations) this.confirmations = Object.assign({}, this.confirmations, confirmations);
        const overlay = bridgeEngineHubEnv({
            indexerUrls: {
                BTC: this.btcIndexerUrl(), DOGE: this.dogeIndexerUrl(), LTC: this.ltcIndexerUrl(),
            },
            confirmations: this.confirmations,
            pollMs: this.pollMs,
        });
        this.btcVenue.hubExtraEnv = Object.assign({}, this.btcVenue.hubExtraEnv || {}, overlay);
        // Each hub then reads its OWN BTC indexer, over the shared URL above; with the
        // standing indexer serving the BTC side there is no per-hub indexer to point at.
        this.btcVenue.hubEnv = this.standingBtcIndexerUrl ? {}
            : hubIndexerEnvMap(this.btcVenue.indexers, 'BTC', this['_hubIndexerOverrides']);
        // ONE AT A TIME, and never all four down at once: the mesh's p2p seed lists name
        // each other, and a hub that boots into a dead mesh spends its whole reconnect
        // backoff before it can take part in a round.
        for (const hub of this.btcVenue.hubs) {
            await this.btcVenue.stopHub(hub.index);
            await this.btcVenue.startHub(hub.index);
        }
        return overlay;
    }

    /**
     * Point ONE hub's origin (BTC) indexer somewhere else, or back at its own with `null`.
     * Restart that hub alone by default, or restart an explicit ordered set during recovery.
     *
     * Exists for policy AT5's abstain leg: a follower whose origin indexer is unreachable
     * must abstain rather than refuse, and stopping a shared indexer would take every hub's
     * read down at once, which is a different claim.
     *
     * @param {number} hubIndex
     * @param {string|null} url  an endpoint, or null to restore the hub's own indexer
     * @param {{restartIndexes?: number[]}} [opts]
     */
    async setHubOriginIndexer(hubIndex, url, opts) {
        assert.ok(this.btcVenue && this.hubs[hubIndex], 'bridgeRailVenue: no hub ' + hubIndex);
        assert.ok(!this.standingBtcIndexerUrl, 'bridgeRailVenue: a venue served by the standing BTC ' +
            'indexer has no per-hub origin endpoint to replace');
        if (url === null || url === undefined) delete this['_hubIndexerOverrides'][hubIndex];
        else this['_hubIndexerOverrides'][hubIndex] = String(url);
        this.btcVenue.hubEnv = hubIndexerEnvMap(this.btcVenue.indexers, 'BTC', this['_hubIndexerOverrides']);
        const requested = opts && Array.isArray(opts.restartIndexes) ? opts.restartIndexes : [hubIndex];
        const restartIndexes = [...new Set(requested.map(Number))];
        assert.ok(restartIndexes.includes(Number(hubIndex)),
            'bridgeRailVenue: origin indexer restart plan omits hub ' + hubIndex);
        for (const index of restartIndexes) {
            assert.ok(Number.isInteger(index) && this.hubs[index],
                'bridgeRailVenue: origin indexer restart plan names no hub ' + index);
            await this.btcVenue.stopHub(index);
            await this.btcVenue.startHub(index);
        }
        return this.btcVenue.hubEnv[hubIndex];
    }

    /**
     * JSON-RPC against one venue hub, keyless.
     *
     * The harness's XChainHubConnector attaches the STANDING stack's HUB_API_KEY from the
     * ambient environment and these hubs are keyless, which is why AttestMirrorVenue's own
     * validator registration goes around it too.
     */
}

const descriptors = Object.getOwnPropertyDescriptors(VenueMethods.prototype);
delete descriptors.constructor;
return descriptors;
}

module.exports = buildVenueLifecycle;
