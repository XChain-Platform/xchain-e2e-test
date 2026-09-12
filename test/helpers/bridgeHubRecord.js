'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * E2E test helper: bridge records built and signed by the HUB's own code.
 *
 * THE POINT OF THIS FILE, and the reason it is not just a fixture builder. The indexer's
 * settle pass rebuilds a signed canonical from a mirrored row and verifies a federation's
 * signatures against it. The hub builds that canonical from its own copy of the rule. The
 * two are separate repositories, and the day they disagree by one byte every transfer on
 * the platform stops verifying while both sides' own unit suites stay green, because each
 * signs and verifies with its own canonical.
 *
 * So every record this helper produces is derived and signed with the HUB's modules:
 * CrossChainBridgeEngine._deriveTransferId, _deriveSnapshotId, _policyHash and
 * _canonicalMatch, signed by xchain-hub's ValidatorIdentity. The drills then hand those
 * records to xchain-indexer's bridge_settle.js. A signature that verifies there is a
 * cross-repo agreement, not a fixture agreeing with itself.
 *
 * The four engine methods used here are pure (they read no instance state), so they are
 * called on a bare prototype instance rather than on a booted engine: a booted engine
 * needs a hub, a database and a P2P mesh, none of which say anything about a canonical.
 * The federated halves of the drills use the real booted engines through
 * multiValidatorHubHelper; this is the half that runs with no venue at all.
 ********************************************************************/

const { loadHubModule } = require('./multiValidatorHubHelper');

const CrossChainBridgeEngine = loadHubModule('src/CrossChainBridgeEngine.js');
const ValidatorIdentity      = loadHubModule('src/ValidatorIdentity.js');

// A bare instance for the pure derivation methods. Object.create leaves every field
// undefined on purpose: if one of these methods ever starts reading instance state, the
// drills go red here rather than silently deriving from a default.
function hubEngine(){
    return Object.create(CrossChainBridgeEngine.prototype);
}

// `count` fresh validator identities, each able to sign as a hub does.
function makeIdentities(count){
    const out = [];
    for(let i = 0; i < count; i++) out.push(new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex));
    return out;
}

// The cross_chain capability set the indexer verifies against: one distinct staking
// source per identity, equal weight, so a full set is over two thirds and a single
// signature is not, under both the weighted and the 2f+1 rule.
function capabilitySet(identities, weight){
    return identities.map((id, i) => ({
        pubkey: id.getPubkeyHex(), source: 'src' + i, weight: String(weight || 100)
    }));
}

/**
 * A bridge_transfers row as the hub's engine derives and finalizes it.
 *
 * transfer_id is derived by the HUB, not typed in: the drills assert it separately against
 * the preimage the spec states, so a change on either side is visible.
 */
function buildTransferRow(fields){
    const f = fields || {};
    const eng = hubEngine();
    const row = {
        snapshot_block:   Number(f.snapshotBlock),
        network:          f.network || 'regtest',
        src_chain:        f.srcChain  || 'BTC',
        src_action_index: Number(f.srcActionIndex),
        src_address:      f.srcAddress || 'mSourceAddressXXXXXXXXXXXXXXXXXXXX',
        dest_chain:       f.destChain || 'DOGE',
        dest_address:     f.destAddress,
        tick:             f.tick     || 'XCHAIN',
        decimals:         Number(f.decimals === undefined ? 8 : f.decimals),
        amount:           String(f.amount),
        effective_time:   Number(f.effectiveTime),
        finalizing_view:  Number(f.view || 0),
        status:           f.status === undefined ? 'finalized' : f.status,
        push_generation:  Number(f.pushGeneration || 0),
        btc_chain_id:     f.btcChainId === undefined ? null : f.btcChainId
    };
    row.transfer_id = eng._deriveTransferId(row.network, row.src_chain, row.src_action_index,
                                            row.dest_chain, row.dest_address, row.snapshot_block);
    return row;
}

/**
 * A policy_snapshots row as the hub's engine derives and finalizes it. policy_hash comes
 * from the HUB's _policyHash over the same arrays that ride along as transport, which is
 * the binding the indexer re-derives; snapshot_id comes from the hub's _deriveSnapshotId.
 */
function buildPolicyRow(fields){
    const f = fields || {};
    const eng = hubEngine();
    const allow = f.allow === undefined ? null : f.allow;
    const block = f.block === undefined ? null : f.block;
    const row = {
        snapshot_block: Number(f.snapshotBlock),
        origin_chain:   f.originChain || 'BTC',
        tick:           f.tick,
        policy_seq:     Number(f.policySeq),
        origin_block:   Number(f.originBlock),
        allow_list:     allow === null ? null : JSON.stringify(allow),
        block_list:     block === null ? null : JSON.stringify(block),
        sleeping:       f.sleeping ? 1 : 0,
        effective_time: Number(f.effectiveTime),
        network:        f.network || 'regtest',
        finalizing_view: Number(f.view || 0),
        status:         f.status === undefined ? 'finalized' : f.status,
        push_generation: Number(f.pushGeneration || 0),
        btc_chain_id:   f.btcChainId === undefined ? null : f.btcChainId
    };
    row.policy_hash = f.policyHash || eng._policyHash(allow, block, !!f.sleeping);
    row.snapshot_id = eng._deriveSnapshotId(row.network, row.origin_chain, row.tick,
                                            row.policy_seq, row.snapshot_block);
    return row;
}

// The canonical the HUB signs for this row, at the row's own finalizing view.
function hubCanonical(row){
    return hubEngine()._canonicalMatch(row, row.finalizing_view != null ? row.finalizing_view : 0);
}

/**
 * Sign `row` with each identity over the HUB's canonical and attach the bundle, the way
 * _writeFinalizedTransfer / _writeFinalizedPolicy attach the PBFT signature set.
 *
 * `opts.message` overrides the signed payload, which is how a drill forges a bundle that
 * is well formed and cryptographically valid but is over the WRONG bytes: that is the
 * failure a bit-flip cannot model, because a flipped signature could always be dismissed
 * as a transport error.
 */
function signRecord(row, identities, opts){
    const o = opts || {};
    const message = o.message !== undefined ? o.message : hubCanonical(row);
    row.validator_signatures = JSON.stringify(identities.map(id => ({
        pubkey: id.getPubkeyHex(), sig: id.sign(message)
    })));
    return row;
}

module.exports = {
    hubEngine,
    makeIdentities,
    capabilitySet,
    buildTransferRow,
    buildPolicyRow,
    hubCanonical,
    signRecord,
    CrossChainBridgeEngine,
    ValidatorIdentity
};
