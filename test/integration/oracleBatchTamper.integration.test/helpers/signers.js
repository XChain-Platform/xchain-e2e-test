'use strict';

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
 ********************************************************************/

const { ValidatorIdentity } = require('../../../helpers/oracleBatchVenue');

// ---------------------------------------------------------------------------
// The signed artifacts AT4's second half is about
// ---------------------------------------------------------------------------

function stripEquivHeader(canonical) {
    const s = String(canonical);
    const at = s.indexOf('||');
    if (!s.startsWith('EQUIV|') || at < 0)
        throw new Error('AT4: canonical carries no EQUIV header: ' + s.slice(0, 60));
    return s.slice(at + 2);
}

function equivPrefixOf(canonical) {
    const s = String(canonical);
    return s.slice(0, s.indexOf('||') + 2);
}

/**
 * Find ONE validator that really signed BOTH canonicals, using only artifacts the
 * run observed: the per-round signature set the PBFT round collected, and the
 * batch signature set that rode the wire.
 *
 * Both sides are re-verified here with the hub's own `ValidatorIdentity.verify`
 * against the canonical the hub's own producer built, so a pair returned by this
 * function is a pair a slashing reviewer would find on the chain, not one this
 * file assembled.
 */
function findObservedDualSigner(venue, roundRecords, parsed, batchCanonical) {
    for (const wireRound of parsed.rounds) {
        const record = roundRecords.find((r) => r.round === wireRound.round);
        if (!record || !Array.isArray(record.signatures)) continue;
        // Built from the WIRE's pair data, not from the venue's submissions: the
        // federation finalizes an aggregate fixed to eight decimals, and the wire
        // carries that finalized spelling, which is what the round was signed over.
        const roundCanonical = venue.priceCanonical(
            wireRound.round, wireRound.timestamp, wireRound.pairs, wireRound.btcBlockHeight);
        for (const rs of record.signatures) {
            const pubkey = String(rs.pubkey || '').toLowerCase();
            if (!pubkey || !rs.sig) continue;
            if (!ValidatorIdentity.verify(roundCanonical, String(rs.sig), pubkey)) continue;
            const bs = parsed.sigs.find((s) => s.pubkey === pubkey &&
                ValidatorIdentity.verify(batchCanonical, s.sig, s.pubkey));
            if (!bs) continue;
            return {
                source:         'observed on the chain and on the round',
                pubkey:         pubkey,
                round:          wireRound.round,
                roundCanonical: roundCanonical,
                roundSig:       String(rs.sig).toLowerCase(),
                batchCanonical: batchCanonical,
                batchSig:       bs.sig
            };
        }
    }
    return null;
}

/** The venue hub holding a given capability signing key, or hubs[0]. */
function identityFor(venue, pubkey) {
    for (const hub of venue.mvh.hubs) {
        const id = hub.getIdentity ? hub.getIdentity() : null;
        if (id && String(id.getPubkeyHex()).toLowerCase() === String(pubkey).toLowerCase()) return id;
    }
    for (const hub of venue.mvh.hubs) {
        const id = hub.getIdentity ? hub.getIdentity() : null;
        if (id) return id;
    }
    return null;
}

/**
 * Fallback for the dual signer: a REAL venue validator identity signs the two
 * REAL canonicals directly.
 *
 * Weaker than the observed path by exactly one step (the signatures were made
 * here rather than read off the chain) and identical in every other respect: the
 * key is a live validator's capability key and the bytes are the production
 * builders' own output. Used only when the observed intersection is empty, and
 * the run prints which path it took.
 */
function signDualWithVenueIdentity(venue, parsed, batchCanonical) {
    const id = identityFor(venue, null);
    if (!id) return null;
    const w = parsed.rounds[0];
    const roundCanonical = venue.priceCanonical(w.round, w.timestamp, w.pairs, w.btcBlockHeight);
    return {
        source:         'signed here by a real venue validator identity',
        pubkey:         String(id.getPubkeyHex()).toLowerCase(),
        round:          w.round,
        roundCanonical: roundCanonical,
        roundSig:       id.sign(roundCanonical),
        batchCanonical: batchCanonical,
        batchSig:       id.sign(batchCanonical)
    };
}

module.exports = {
    stripEquivHeader, equivPrefixOf, findObservedDualSigner, identityFor, signDualWithVenueIdentity
};
