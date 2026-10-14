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

const { Slash } = require('./indexer_modules');

// ---------------------------------------------------------------------------
// The SLASH harness
//
// The real handler, a permissive DB. Every stub below is set so that the ONLY
// thing able to stop a burn is the equivocation logic: the offender is in the
// price capability snapshot at whatever block the proof resolves, has never been
// slashed, stakes in its own name, and holds a burnable bond. A refusal from this
// harness is therefore a refusal by the tag/round-id design and by nothing else.
// ---------------------------------------------------------------------------

function slashHarness(offenderPubkey) {
    const calls = { capabilityLookups: [], burns: [], events: [] };

    const indexerDb = {
        getValidatorsByCapability: async (capability, block) => {
            calls.capabilityLookups.push({ capability: capability, block: block });
            return [{ pubkey: offenderPubkey, amount: '1000' }];
        },
        getActiveValidators:             async () => [{ pubkey: offenderPubkey, amount: '1000' }],
        getOrCreatePubkeyId:             async () => 7,
        hasCapabilitySlashEvent:         async () => false,
        getStakeSourceForDelegatedPubkey: async () => null,
        // { total, releases }: a bond is LOCKED in the staker's escrow, so the burn reports
        // whose escrow it reduced and the handler releases it there before redirecting any
        // of it. A bare total cannot be attributed (a delegated key's bond lives on the
        // owning source), which is why the shape changed.
        slashCapabilityStake: async (pubkeyId, blockIndex, actionIndex, burnPending, ownerSourceId) => {
            calls.burns.push({ pubkeyId, blockIndex, actionIndex, burnPending, ownerSourceId });
            return { total: '1000', releases: [{ address: 'staker1', amount: '1000' }] };
        },
        createCapabilitySlashEvent: async (row) => { calls.events.push(row); },
        getAddressId:               async () => 1,
        updateBalances:             async () => {},
        updateTokens:               async () => {}
    };

    // Only the arithmetic and list helpers the handler reaches. The amounts here
    // never leave this process: with no STAKING.CAPABILITIES.price.SLASH config the
    // split is a pure burn, so nothing is credited and no precision question arises.
    const util = {
        isNull: (v) => v === null || v === undefined || v === '',
        bcgt:   (a, b) => Number(a) > Number(b),
        bcsub:  (a, b) => String(Number(a) - Number(b)),
        bcmul:  (a, b) => String(Number(a) * Number(b)),
        bcdiv:  (a, b) => String(Number(a) / Number(b)),
        processTransactionLedgerChanges: async () => {},
        getTickersList:   () => [],
        getAddressesList: () => ({}),
        addAddressTicker: () => {}
    };

    const ctx = {
        config:    { GAS: 'XCHAIN', NETWORK: 'regtest' },
        util:      util,
        mapper:    { createMappings: async () => {} },
        decoderDb: {},
        indexerDb: indexerDb,
        protocolChanges: {
            isDefined: () => true,
            // Both gates the handler reads (SLASH_ORACLE_ROUND_DISCRIMINATED and
            // SLASH_BURNS_PENDING_STAKE) resolved ON, which is the strictest setting
            // for the honest pair and the most permissive for the counterfactual.
            isEnabled: async () => true
        }
    };

    return { handler: new Slash(ctx), calls: calls };
}

const b64url = (s) => Buffer.from(String(s), 'utf8').toString('base64url');

async function runSlashProof(harness, capability, offender, msgA, sigA, msgB, sigB, blockIndex) {
    const data = {
        FORMAT: 0, COIN: 'BTC', BLOCK_INDEX: blockIndex, ACTION_INDEX: 1,
        SOURCE: 'xchain-at4-submitter', BLOCK_TIME: 1700000000
    };
    await harness.handler.parse(
        ['0', capability, offender, b64url(msgA), String(sigA), b64url(msgB), String(sigB)],
        data, null);
    return String(data['STATUS']);
}

module.exports = { slashHarness, runSlashProof };
