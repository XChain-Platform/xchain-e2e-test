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
 * E2E test helper: an indexer settle-pass context for the XBRIDGE drills.
 *
 * The bridge drills feed a REAL hub-signed record into the REAL indexer settle pass
 * (xchain-indexer/src/bridge_settle.js), the way multiHubCrossSettleE2E feeds a real
 * federated match into the real cross_settle handler. That pass needs an indexer
 * database and an actions object; a live indexer needs a chain rail, which the bridge
 * drills deliberately do not depend on, so the ledger is held in memory here and every
 * effect the pass produces is recorded for the drill to read back.
 *
 * WHAT IS REAL AND WHAT IS A STAND-IN. The verdicts, the canonical, the quorum
 * arithmetic, the escrow cross-check, the amount formatting, the ledger PLAN and the
 * settlement record all come from the real modules: IndexerUtility is a real instance
 * over the drill's config, and every guard the pass evaluates runs. Only the rows the
 * pass reads and writes are held in this object, which is what makes the credits and
 * debits readable as data rather than inferred from a return value.
 *
 * Nothing here decides an outcome. A helper that answered a guard for the pass would
 * make every drill built on it pass against broken code, so each stub either records
 * what it was asked to do or returns exactly what the caller seeded.
 ********************************************************************/

const path = require('path');
const fs   = require('fs');

// Locate the xchain-indexer package, the way multiValidatorHubHelper locates xchain-hub:
// adjacent in the monorepo (host-process dev), staged into the e2e build context, or
// under xchain-node's modules/. An explicit override wins.
function resolveIndexerFile(rel){
    const candidates = [
        process.env.XCHAIN_INDEXER_PATH && path.join(process.env.XCHAIN_INDEXER_PATH, rel),
        path.resolve(__dirname, '../../xchain-indexer', rel),
        path.resolve(__dirname, '../../../xchain-indexer', rel),
        path.resolve(__dirname, '../../../../xchain-indexer', rel),
        path.resolve(__dirname, '../../../../../modules/xchain-indexer', rel)
    ].filter(Boolean);
    for(const p of candidates){
        if(fs.existsSync(p)) return p;
    }
    throw new Error(
        'bridgeSettleContext: cannot resolve xchain-indexer source. Set XCHAIN_INDEXER_PATH ' +
        'to the xchain-indexer directory or place it adjacent to xchain-e2e-test. Tried: ' +
        candidates.join(', '));
}

function loadIndexerModule(rel){ return require(resolveIndexerFile(rel)); }

const IndexerUtility = loadIndexerModule('src/utility.js');
const bridgeSettle   = loadIndexerModule('src/bridge_settle.js');
const checkpointCheck = loadIndexerModule('src/bridge_checkpoint_check.js');
const merkle         = loadIndexerModule('src/merkle.js');
const subtree        = loadIndexerModule('src/state_subtree_activation.js');

// Placeholder keyless role addresses. The settle pass only ever reads these out of the
// config it is handed, so the literal value decides nothing; the one address that must
// be REAL is the escrow the cross-check resolves for itself (see buildEscrowProof).
const ROLE_ADDRESSES = {
    GAS:         'nGasOwnerXXXXXXXXXXXXXXXXXXXXXXXXX',
    BRIDGE_BTC:  'nDOGEEscrowForBtcXXXXXXXXXXXXXXXXX',
    BRIDGE_DOGE: 'mBTCEscrowForDogeXXXXXXXXXXXXXXXXX',
    BRIDGE_LTC:  'mBTCEscrowForLtcXXXXXXXXXXXXXXXXXX'
};

/**
 * A settle-pass context over an in-memory ledger.
 *
 * @param opts.coin           this chain's coin (the destination leg's chain)
 * @param opts.network        network name, 'regtest' unless a drill needs a mismatch
 * @param opts.validators     [{pubkey, source, weight}] the cross_chain capability set at
 *                            snapshot_block; an EMPTY array models a snapshot that has not
 *                            been mirrored here yet, which the pass treats as a retry
 * @param opts.tokens         { tick: { TICK_ID, DECIMALS, SUPPLY, OWNER, ALLOW_LIST, ... } }
 * @param opts.balances       { tick_id: amount } for whichever address is read (the escrow)
 * @param opts.settled        pre-existing '<id>|<kind>' settlement keys
 * @param opts.mirrorPolicies rows the policy seq-gap query sees
 * @param opts.chainId        this node's BTC_CHAIN_ID, for the chain-identity guard
 * @param opts.blockIndex     the applying block
 * @param opts.blockTime      the block loop's PROTOCOL time; effective_time compares to it
 * @returns {{ctx: Object, state: Object, config: Object}}
 */
function makeSettleContext(opts){
    const o = opts || {};
    const config = {
        COIN:         o.coin || 'DOGE',
        NETWORK:      o.network || 'regtest',
        GAS:          'XCHAIN',
        GAS_PRICE:    '0.00001',
        ADDRESS:      Object.assign({}, ROLE_ADDRESSES, o.addresses || {}),
        BTC_CHAIN_ID: o.chainId === undefined ? null : o.chainId
    };

    const state = {
        credits: [], debits: [], settlements: [], actions: [], mappings: [], injected: [],
        balances: Object.assign({}, o.balances || {}),
        settled:  new Set(o.settled || []),
        tokens:   Object.assign({}, o.tokens || {}),
        mirrorPolicies:  (o.mirrorPolicies  || []).slice(),
        mirrorTransfers: (o.mirrorTransfers || []).slice()
    };
    let nextAction = o.firstActionIndex || 5000;

    // The mirror side, read through indexerDb._mirrorDb(). Honours an ORDER BY only when
    // the SQL actually carries one, so an ordering drill proves the QUERY carries the
    // consensus order instead of proving this fixture was handed a sorted array.
    const mirror = {
        doQuery: async (sql) => {
            if(/FROM bridge_transfers/.test(sql)){
                const rows = state.mirrorTransfers.slice();
                if(/ORDER BY snapshot_block ASC, transfer_id ASC/.test(sql))
                    rows.sort((a, b) => (Number(a.snapshot_block) - Number(b.snapshot_block)) ||
                                        (String(a.transfer_id) < String(b.transfer_id) ? -1 : 1));
                return rows;
            }
            if(/FROM policy_snapshots/.test(sql)){
                const rows = state.mirrorPolicies.slice();
                if(/ORDER BY policy_seq ASC/.test(sql))
                    rows.sort((a, b) => Number(a.policy_seq) - Number(b.policy_seq));
                return rows;
            }
            return [];
        }
    };

    const indexerDb = {
        config: config,
        _mirrorDb: () => mirror,
        doQuery: async (sql, args) => {
            args = args || [];
            if(/FROM bridge_settlements/.test(sql) && /LIMIT 1/.test(sql))
                return state.settled.has(String(args[0]) + '|' + String(args[1]))
                    ? [{ transfer_id: args[0] }] : [];
            if(/FROM bridge_settlements/.test(sql)){
                const kind = /kind = 'policy'/.test(sql) ? 'policy' : 'transfer';
                return args.filter(id => state.settled.has(String(id) + '|' + kind))
                           .map(id => ({ transfer_id: id }));
            }
            if(/INSERT IGNORE INTO bridge_settlements/.test(sql)){
                state.settlements.push({
                    action_index: args[0], transfer_id: args[1], kind: args[2],
                    block_index: args[3], src_chain: args[4], src_action_index: args[5],
                    dest_chain: args[6], dest_address: args[7], tick: args[8]
                });
                state.settled.add(String(args[1]) + '|' + String(args[2]));
                return [];
            }
            return [];
        },
        // Both quorum doors answer the same seeded set: which one the pass reaches is
        // decided by the stake-weighted activation, and a drill that seeded one but not
        // the other would read as a quorum failure for the wrong reason.
        getValidatorsByCapability:   async () => (o.validators || []).slice(),
        getStakeWeightsByCapability: async () => (o.validators || []).slice(),
        createActionIndex: async (data) => { state.actions.push(data); return nextAction++; },
        getTokenInfo:   async (tick) => state.tokens[tick] || null,
        getTickerId:    async (tick) => (state.tokens[tick] ? state.tokens[tick]['TICK_ID'] : null),
        getAddressBalances: async () => Object.assign({}, state.balances),
        getAddressPreferences: async () => null,
        createDebit:    async (ai, tick, amount, address) => { state.debits.push([tick, String(amount), address]); },
        createCredit:   async (ai, tick, amount, address) => { state.credits.push([tick, String(amount), address]); },
        createEscrow:   async () => {},
        updateBalances: async () => {},
        updateTokens:   async () => {},
        getList:        async (index) => ((o.lists || {})[String(index)] || []).slice(),
        isTickSleeping: async () => false,
        getPushGeneration: async () => 0
    };

    const util   = new IndexerUtility(config);
    const mapper = { createMappings: async (d) => { state.mappings.push(d); } };
    const actions = {
        mapper: mapper,
        // Injected token rows and policy legs come through here. The reply is the shape
        // processTransaction gives a valid action; a drill that needs an injected leg to
        // FAIL seeds processTransactionResult to return a non-valid status.
        processTransaction: async (tx, isGenesis) => {
            state.injected.push({ data: tx.data, source: tx.source, tx_hash: tx.tx_hash,
                                  vout: tx.vout, isGenesis: isGenesis === true });
            if(typeof o.processTransactionResult === 'function')
                return o.processTransactionResult(tx, nextAction++);
            return { ACTION_INDEX: nextAction++, STATUS: 'valid' };
        }
    };

    const ctx = {
        actions:    actions,
        indexerDb:  indexerDb,
        util:       util,
        mapper:     mapper,
        config:     config,
        coin:       config.COIN,
        network:    config.NETWORK,
        blockIndex: o.blockIndex === undefined ? 900  : o.blockIndex,
        blockTime:  o.blockTime  === undefined ? 2000 : o.blockTime
    };
    if(o.proof !== undefined) ctx.proof = o.proof;

    return { ctx: ctx, state: state, config: config };
}

/**
 * A complete, VALID escrow-proof envelope for `balance` of `tick` held by the escrow the
 * cross-check resolves for itself, built from the real sparse Merkle tree and the real
 * state-root assembly.
 *
 * The escrow address is READ THROUGH THE SAME DOOR the check reads it (the origin chain's
 * own coin config), never typed in here: an envelope naming a fixture address fails
 * PROOF_BINDING before any root arithmetic runs, and a drill built on one would report a
 * refusal that says nothing about the balance it meant to prove.
 *
 * @param opts.srcChain    the escrow (origin) chain, 'BTC' for every base-spec leg
 * @param opts.destChain   the minting chain, which selects the escrow role address
 * @param opts.network     network name
 * @param opts.tick        the tick the escrow holds, as signed into the record
 * @param opts.balance     the escrow balance to prove, as a decimal string
 * @param opts.height      the checkpoint height; must be at or above snapshot_block
 * @param opts.forgeRoot   true swaps in a state root the escrow leaf is NOT under, which
 *                         is what a forged proof looks like to the check
 */
function buildEscrowProof(opts){
    const o        = opts || {};
    const srcChain = o.srcChain || 'BTC';
    const network  = o.network  || 'regtest';
    const tick     = o.tick     || 'XCHAIN';
    const height   = Number(o.height);
    const escrow   = checkpointCheck.resolveEscrowAddress(srcChain, o.destChain || 'DOGE', network);
    if(!escrow)
        throw new Error('bridgeSettleContext: no escrow role address for ' + srcChain +
                        ' -> ' + (o.destChain || 'DOGE') + ' on ' + network);

    const smt = new merkle.SparseMerkleTree();
    const key = merkle.balanceKey(srcChain, network, escrow, tick);
    smt.set(key, merkle.amountLeaf(String(o.balance)));
    // A second holder so the tree is not a single-leaf degenerate case, which would make a
    // sibling-path assertion vacuous.
    smt.set(merkle.balanceKey(srcChain, network, 'mOtherHolderXXXXXXXXXXXXXXXXXXXXXX', tick),
            merkle.amountLeaf('41.5'));

    const subRoots = { balances_root: smt.rootHex(), stakes_root: merkle.toHex(merkle.EMPTY_SMT_ROOT) };
    // The forged variant commits a DIFFERENT balances root: the envelope is well formed and
    // the checkpoint binds, so the only thing that can refuse it is the root arithmetic.
    const committed = o.forgeRoot
        ? { balances_root: new merkle.SparseMerkleTree().rootHex(), stakes_root: subRoots.stakes_root }
        : subRoots;

    return {
        chain: srcChain, network: network, block_index: height,
        sub_roots: subRoots,
        address: escrow, tick: tick, balance: String(o.balance),
        balance_proof: { siblings: smt.prove(key).siblings },
        checkpoint: {
            chain: srcChain, network: network, block_index: height, checkpoint_seq: 77,
            snapshot_block: height,
            state_root: merkle.toHex(merkle.stateRoot(committed)),
            state_root_version: subtree.stateRootVersion(height, network, srcChain)
        }
    };
}

module.exports = {
    makeSettleContext,
    buildEscrowProof,
    resolveIndexerFile,
    loadIndexerModule,
    bridgeSettle,
    checkpointCheck,
    ROLE_ADDRESSES
};
