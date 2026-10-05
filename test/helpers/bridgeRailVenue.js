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
 *********************************************************************/

'use strict';

const axios = require('axios');
const mariadb = require('mariadb');
const { AttestMirrorVenue } = require('./attestMirrorVenue');
const chainRail = require('./chainRail');
const xchainPrice = require('./xchainPriceConstants');
const { evidenceJson } = require('./rail_preflight/evidence_json');
const { DEFAULT_CONFIRMATIONS, DEFAULT_POLL_MS } = require('./bridge_rail_venue/constants');
const { venueAdmissionEnv } = require('./bridge_rail_venue/environment');

class BridgeRailVenue {

    /**
     * @param opts.label          short name, used in database names and log lines
     * @param opts.identities     `[{pubkeyHex, privkeyHex}]` for the seated keys; REQUIRED,
     *                            because a venue that cannot sign for the seated set
     *                            finalizes nothing and a generated key would look identical
     *                            at boot
     * @param opts.network        default regtest; the venue refuses anything else
     * @param opts.confirmations  `{BTC: 1, DOGE: 1, LTC: 1}`; the rail's pinned depth
     * @param opts.basePort       port probe base
     * @param opts.dogeRail       a chainRail for dogecoin; built here when omitted
     * @param opts.withLtc        build an attached Litecoin indexer; default false
     * @param opts.pollMs         engine poll cadence
     */
    constructor(opts) {
        const o = opts || {};
        this.label   = String(o.label || 'bridgerail').replace(/[^A-Za-z0-9]/g, '');
        this.network = o.network || 'regtest';
        if (this.network !== 'regtest') {
            throw new Error('bridgeRailVenue: refusing to build on ' + this.network +
                '. This venue clones chain databases, spawns validators on borrowed stake and ' +
                'pins confirmation depths down; every one of those is a regtest-only act.');
        }
        this.identities    = o.identities || null;
        this.confirmations = Object.assign({}, DEFAULT_CONFIRMATIONS, o.confirmations || {});
        this.basePort      = o.basePort || 43000;
        this.pollMs        = o.pollMs === undefined ? DEFAULT_POLL_MS : o.pollMs;
        this.withLtc       = o.withLtc === true;
        this.btcRail       = o.btcRail || null;
        this.dogeRail      = o.dogeRail || null;
        this.ltcRail       = o.ltcRail || null;
        // WHICH TREE THE IN-PROCESS HUBS AND INDEXERS ARE LOADED FROM, and the evidence
        // depends on it. attestMirrorVenue spawns `<repoRoot>/xchain-hub/src/api.js` and
        // `<repoRoot>/xchain-indexer/src/api.js` and defaults repoRoot to the checkout this
        // file sits in, which is SHARED: several sessions' uncommitted hub edits are on disk
        // there at any moment, and drive 12 was aborted because its four venue hubs would
        // have been three other sessions' work rather than the landed bridge code. Pointing
        // this at a root of detached worktrees at named SHAs is what makes an acceptance
        // readout attributable. Env fallback so a drive script can set it without a code
        // edit; unset keeps the old shared-tree behaviour.
        this.repoRoot = o.repoRoot || process.env.BRIDGE_RAIL_REPO_ROOT || null;
        this.admission = venueAdmissionEnv(o.mirrorAdmission !== undefined
            ? o.mirrorAdmission : process.env.XC_MIRROR_ADMISSION_ACTIVATION);
        // The ruled shape: the STANDING BTC indexer serves the BTC-side legs. Unset means
        // build a venue BTC indexer instead; see the header for when each is right.
        this.standingBtcIndexerUrl = o.btcIndexerUrl || null;
        // ONE VENUE BTC INDEXER PER HUB by default, following that hub and read by it, which
        // is how a validator node is wired (see hubIndexerEnvMap). `btcIndexerPerHub: false`
        // keeps the single shared indexer, and a drive that asks for it cannot drive a
        // signed retraction or a follower that abstains.
        this.btcIndexerPerHub = o.btcIndexerPerHub !== false;
        // `{hubIndex: url}`: a hub pointed at an origin endpoint other than its own
        // indexer, set and cleared through `setHubOriginIndexer`.
        this['_hubIndexerOverrides'] = {};
        // dq 5, ruled (a) 2026-09-12: the venue DOGE indexer REPLAYS the standing DOGE
        // chain under this tree's bridge code rather than copying the standing node's
        // ledger, so the pre-D62 self-seeded XCHAIN ISSUE at DOGE action_index 326 is
        // refused and AT1's precondition (no XCHAIN row on the destination ledger) is a
        // fact about the ledger rather than a wish. Default ON for this venue, because a
        // bridge rail built on the cloned ledger cannot assert AT1 at all; pass
        // `dogeReplayChain: false` for a drive that deliberately wants the standing
        // grading, and say why.
        this.dogeReplayChain = o.dogeReplayChain === undefined ? true : (o.dogeReplayChain === true);
        // LEAVE THE BRIDGE ENGINE UNARMED AT start(), and this exists for one measured
        // reason. `getpendingbridgetransfers` answers every valid XBRIDGE leg this chain
        // has carried that its own MIRROR holds no transfer for (xchain-indexer
        // src/db/bridges/index.js getPendingBridgeTransfers, filtered since d93294d8;
        // before that, every leg forever). A venue hub's database is new on every run and
        // the venue indexers' mirrors are dropped with it, so the instant its engine has
        // indexer URLs it re-proposes the whole history of locks on the rail, and a
        // destination ledger with no prior `bridge_settlements` row applies them. On this rail that is 35 XCHAIN from earlier drive attempts whose
        // keys were random per process and are gone, so the escrow cannot be drained and
        // the rail can never be virgin again.
        //
        // A drive that must READ the destination ledger before any of that happens (AT1's
        // precondition, AT9's before-witness) therefore arms the engine itself, by calling
        // `rewireHubs()` once those readings are taken, rather than racing a 240-second
        // effective_time window it does not control.
        this.deferBridgeWiring = o.deferBridgeWiring === true;

        this.btcVenue  = null;   // hubs + the BTC indexer
        this.dogeVenue = null;   // the DOGE indexer, attached to the same hubs
        this.ltcVenue  = null;   // the optional LTC indexer, attached to the same hubs
        this.unavailable = null; // non-null means the caller should SKIP
        this['_replayVenues'] = new Set();
        this['_replaySerial'] = 0;

        // Which indexer answered which readout, recorded rather than assumed. The ruling
        // named the standing BTC indexer; the header says why it cannot serve today, and
        // this is the record the evidence quotes.
        this['_served'] = {};
    }

    get hubs()    { return this.btcVenue ? this.btcVenue.hubs : []; }
    get hubDb()   { return this.btcVenue ? this.btcVenue.hubDb : null; }
    btcIndexer()  { return this.btcVenue  ? this.btcVenue.indexers[0]  : null; }
    dogeIndexer() { return this.dogeVenue ? this.dogeVenue.indexers[0] : null; }
    ltcIndexer()  { return this.ltcVenue  ? this.ltcVenue.indexers[0]  : null; }
    btcIndexerUrl()  {
        if (this.standingBtcIndexerUrl) return this.standingBtcIndexerUrl;
        const ix = this.btcIndexer();
        return ix ? ix.apiUrl : '';
    }
    dogeIndexerUrl() { const ix = this.dogeIndexer(); return ix ? ix.apiUrl : ''; }
    ltcIndexerUrl()  { const ix = this.ltcIndexer();  return ix ? ix.apiUrl : ''; }

    ['_chainIndexer'](chain) {
        const tick = String(chain).toUpperCase();
        if (tick === 'BTC') return this.btcIndexer();
        if (tick === 'DOGE') return this.dogeIndexer();
        if (tick === 'LTC') return this.ltcIndexer();
        throw new Error('bridgeRailVenue: unsupported chain ' + chain);
    }

    ['_chainIndexerUrl'](chain) {
        const tick = String(chain).toUpperCase();
        if (tick === 'BTC') return this.btcIndexerUrl();
        if (tick === 'DOGE') return this.dogeIndexerUrl();
        if (tick === 'LTC') return this.ltcIndexerUrl();
        throw new Error('bridgeRailVenue: unsupported chain ' + chain);
    }

    /**
     * Record and report which service served a readout, so the evidence names it.
     */
    servedBy(readout, service) {
        if (service !== undefined) this['_served'][readout] = service;
        return this['_served'][readout];
    }
    servedMap() { return Object.assign({}, this['_served']); }

    /**
     * Bring the mesh up. Returns true when it is usable, false with `unavailable` set.
     */
}

const constants = require('./bridge_rail_venue/constants');
const environment = require('./bridge_rail_venue/environment');
const quorum = require('./bridge_rail_venue/quorum');
const wire = require('./bridge_rail_venue/wire');
const venueHelpers = require('./bridge_rail_venue/venue_helpers');
const publicVenueHelpers = Object.assign({}, venueHelpers);
delete publicVenueHelpers.roleConfigFor;
const transferDiagnostics = require('./bridge_rail_venue/transfer_diagnostics');
const reorg = require('./bridge_rail_venue/reorg_controls');
const mining = require('./bridge_rail_venue/mining_controls');
const runtime = { axios, mariadb, AttestMirrorVenue, chainRail, xchainPrice, evidenceJson };
const funding = require('./bridge_rail_venue/funding_diagnostics')(runtime);
const standalone = require('./bridge_rail_venue/standalone_venue')(runtime);

for (const methods of [
    require('./bridge_rail_venue/venue_lifecycle')(runtime),
    require('./bridge_rail_venue/venue_reads')(runtime),
    require('./bridge_rail_venue/venue_transfer_reads')(
        Object.assign({ verdictOf: standalone.verdictOf }, runtime)),
    require('./bridge_rail_venue/venue_settlement')(funding),
    require('./bridge_rail_venue/venue_diagnostics')(runtime),
]) {
    Object.defineProperties(BridgeRailVenue.prototype, methods);
}

const WITNESS_VERDICTS = {};

module.exports = Object.assign({ BridgeRailVenue, WITNESS_VERDICTS }, standalone,
    environment, quorum, wire, publicVenueHelpers, transferDiagnostics, reorg, mining, funding, {
        BRIDGE_CHAINS: constants.BRIDGE_CHAINS,
        DEFAULT_CONFIRMATIONS: constants.DEFAULT_CONFIRMATIONS,
        DEFAULT_POLL_MS: constants.DEFAULT_POLL_MS,
    });
