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
 ********************************************************************/

'use strict';

// The falsified policy snapshots policy AT4 feeds the settle pass, one moved property each.

const { HUB, NETWORK, SNAPSHOT, ORIGIN_BLK, DUE_TIME, TICK, MEMBER_A, MEMBER_B, snapshot } = require('./shared');

const falsificationCases = [
    {
        name: 'membership that does not hash to the signed policy_hash',
        // The row is signed over a canonical carrying hash(ALLOW -, BLOCK [A]) while
        // the transport arrays say [B]: exactly the substitution the hash exists to
        // catch, and the signature is genuine.
        build: (ids) => {
            const row = snapshot(ids, { block: [MEMBER_A] });
            row.block_list = JSON.stringify([MEMBER_B]);
            return row;
        },
        terminal: true
    },
    {
        name: 'membership out of canonical byte order',
        build: (ids) => {
            const row = HUB.buildPolicyRow({
                snapshotBlock: SNAPSHOT, originChain: 'BTC', tick: TICK, policySeq: 1,
                originBlock: ORIGIN_BLK, effectiveTime: DUE_TIME, network: NETWORK,
                block: [MEMBER_B, MEMBER_A]        // descending: never canonical
            });
            return HUB.signRecord(row, ids);
        },
        terminal: true
    },
    {
        name: 'membership transport that is not a JSON array',
        build: (ids) => {
            const row = snapshot(ids, { block: [MEMBER_A] });
            row.block_list = '{"not":"an array"}';
            return row;
        },
        terminal: true
    },
    {
        name: 'a bundle signed over other bytes',
        build: (ids) => {
            const row = snapshot([], { block: [MEMBER_A] });
            const other = HUB.buildPolicyRow({
                snapshotBlock: SNAPSHOT, originChain: 'BTC', tick: TICK, policySeq: 9,
                originBlock: ORIGIN_BLK, effectiveTime: DUE_TIME, network: NETWORK,
                block: [MEMBER_A]
            });
            return HUB.signRecord(row, ids, { message: HUB.hubCanonical(other) });
        },
        terminal: true
    },
    {
        name: 'a signer outside the capability snapshot',
        build: () => snapshot(HUB.makeIdentities(3), { block: [MEMBER_A] }),
        terminal: true
    },
    {
        name: 'a foreign network',
        build: (ids) => snapshot(ids, { block: [MEMBER_A], network: 'testnet' }),
        terminal: true
    }
];

module.exports = { falsificationCases };
