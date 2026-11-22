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

// The falsified transfer records base AT4 feeds the settle pass, one moved property each.

const { HUB, inLeg } = require('./shared');

const falsificationCases = [
    {
        name: 'a bundle signed over other bytes',
        build: (ids) => HUB.signRecord(inLeg([]), ids, {
            message: HUB.hubCanonical(Object.assign(inLeg([]), { dest_address: 'nAttacker' }))
        })
    },
    {
        name: 'a signer outside the capability snapshot',
        build: () => HUB.signRecord(inLeg([]), HUB.makeIdentities(3))
    },
    {
        name: 'a foreign network',
        build: (ids) => inLeg(ids, { network: 'testnet' })
    },
    {
        name: 'a status that is not finalized',
        build: (ids) => inLeg(ids, { status: 'retracted' })
    },
    {
        name: 'a destination chain that is not this chain',
        build: (ids) => inLeg(ids, { destChain: 'LTC' })
    }
];

module.exports = { falsificationCases };
