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
 * (xchain-indexer/src/consensus/bridge_settle.js), the way multiHubCrossSettleE2E feeds a real
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
const bridgeSettle   = loadIndexerModule('src/consensus/bridge_settle.js');
const checkpointCheck = loadIndexerModule('src/consensus/bridge_checkpoint_check.js');
const merkle         = loadIndexerModule('src/consensus/merkle.js');
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

    // The mirror side, read through indexerDb._mirrorDb(). These reads live in xchain-indexer
    // src/db/bridge_settlements.js as named methods, so the fixture answers those methods and
    // returns each result set in the order its method documents. The ORDER BY belongs to the
    // mixin and is graded in the indexer's own suite.
    const mirror = {
        // Consensus order, applied here rather than taken as seeded, so a caller that depends
        // on it gets it from the read and not from the order a drill happened to list rows in.
        getFinalizedBridgeTransfersForChain: async () =>
            state.mirrorTransfers.slice()
                 .sort((a, b) => (Number(a.snapshot_block) - Number(b.snapshot_block)) ||
                                 (String(a.transfer_id) < String(b.transfer_id) ? -1 : 1)),

        // Unsorted on purpose: the real read carries no ORDER BY because duePolicySnapshots
        // builds the total order itself, and sorting here would hide a caller that stopped.
        getFinalizedPolicySnapshots: async () => state.mirrorPolicies.slice(),

        // Seeded rows model what the mirror holds for the row under test, so only the seq bound
        // is applied; a drill states the network, origin and tick it means by seeding the rows
        // it wants this read to see.
        getEarlierFinalizedPolicySnapshots: async (network, originChain, tick, seq) =>
            state.mirrorPolicies.filter(r => Number(r.policy_seq) < Number(seq))
                 .sort((a, b) => Number(a.policy_seq) - Number(b.policy_seq)),

        // The pass reaches the mirror only through the methods above. Raw SQL for either
        // mirrored table means a read slipped back out of the db mixin, and answering it with
        // an empty set would green every drill built on that read.
        doQuery: async (sql) => {
            if(/bridge_transfers|policy_snapshots/.test(sql))
                throw new Error('bridgeSettleContext: raw mirror SQL reached the stub ('
                    + String(sql).replace(/\s+/g, ' ').slice(0, 80)
                    + '). That read belongs in xchain-indexer src/db/bridge_settlements.js.');
            return [];
        }
    };

    const indexerDb = {
        config: config,
        _mirrorDb: () => mirror,
        // The settle pass's bridge_settlements reads and writes live in xchain-indexer
        // src/db/bridge_settlements.js as named methods, so the fixture implements the ones the
        // pass calls. Every one answers from `state` and decides nothing; a stub that answered
        // a guard would pass each drill built on it against broken code.

        // The LOCAL ledger's id-keyed read. `kind` is inside the key, so a transfer id and a
        // snapshot id may collide in the id column without colliding as settlements.
        isBridgeSettlementRecorded: async (id, kind) =>
            state.settled.has(String(id) + '|' + String(kind)),

        // Keyed on the source leg alone and never on transfer_id. Answered from the settlements
        // this run RECORDED, because that is the only place the fixture holds source columns: a
        // seeded `settled` key names an id and a kind and says nothing about a leg.
        isBridgeSourceLegSettled: async (srcChain, srcActionIndex) =>
            state.settlements.some(s => s.kind === 'transfer'
                && s.src_chain !== null && s.src_chain !== undefined
                && s.src_action_index !== null && s.src_action_index !== undefined
                && String(s.src_chain) === String(srcChain)
                && Number(s.src_action_index) === Number(srcActionIndex)),

        getRecordedTransferSettlementIds: async (ids) =>
            (ids || []).filter(id => state.settled.has(String(id) + '|transfer'))
                       .map(id => ({ transfer_id: id })),

        getRecordedPolicySettlementIds: async (ids) =>
            (ids || []).filter(id => state.settled.has(String(id) + '|policy'))
                       .map(id => ({ transfer_id: id })),

        // The CROSS PRODUCT of the candidate chains and indexes, exactly the shape the real
        // query's two IN lists select. The caller matches the pair itself, so returning
        // pre-matched pairs here would hide a caller that stopped matching them.
        getSettledBridgeSourceLegs: async (legChains, legIndexes) =>
            state.settlements.filter(s => s.kind === 'transfer'
                && (legChains  || []).some(c => String(c) === String(s.src_chain))
                && (legIndexes || []).some(i => Number(i) === Number(s.src_action_index)))
                .map(s => ({ src_chain: s.src_chain, src_action_index: s.src_action_index })),

        recordBridgeSettlement: async (actionIndex, id, kind, blockIndex, srcChain,
                                       srcActionIndex, destChain, destAddress, tick) => {
            state.settlements.push({
                action_index: actionIndex, transfer_id: String(id), kind: String(kind),
                block_index: blockIndex, src_chain: srcChain, src_action_index: srcActionIndex,
                dest_chain: destChain, dest_address: destAddress, tick: tick
            });
            state.settled.add(String(id) + '|' + String(kind));
        },

        // The pass reaches its own ledger only through the methods above. Raw bridge_settlements
        // SQL arriving here means a read sits outside the db mixin, and that has to be loud:
        // answering it with an empty set would green every drill built on that read.
        doQuery: async (sql) => {
            if(/bridge_settlements/.test(sql))
                throw new Error('bridgeSettleContext: raw bridge_settlements SQL reached the stub ('
                    + String(sql).replace(/\s+/g, ' ').slice(0, 80)
                    + '). That read belongs in xchain-indexer src/db/bridge_settlements.js.');
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
