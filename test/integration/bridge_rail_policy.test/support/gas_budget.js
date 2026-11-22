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

// Can the policy rail bootstrap pay for its temporary stakes before it sends any of them?
//
// The bootstrap sizes its stakes to outweigh every seated key it cannot sign for, two to
// one. On a long-lived regtest that seated weight only grows, and the XCHAIN it must
// draw comes from three places: recorded donors, the keyed gas faucet, and whatever
// MINT headroom is left under the gas tick's MAX_SUPPLY. When the three together fall
// short, every later step is wasted work, and the last MINT grades
// `invalid: mint exceeds MAX_SUPPLY` after the full action wait. This check fails
// before anything is broadcast, and says which number is short.

const gasFaucet = require('../../../helpers/rail/gas_faucet');

const SCALE = 10n ** 8n;

function whole(units) {
    return (units / SCALE).toString();
}

function sumUnits(values) {
    return values.reduce((total, value) => {
        const units = gasFaucet.units(value);
        return units === null ? total : total + units;
    }, 0n);
}

// Pure: compare the need with what the three sources can reach. `supply` is
// { supply, maxSupply } or null; an unreadable supply leaves the MINT path open, the
// same rule gas_faucet.planGasFunding applies, so this check never refuses on a read
// it could not make.
function planBootstrapGas({ need, faucet = [], donors = [], supply = null }) {
    const needUnits = gasFaucet.units(String(need));
    if (needUnits === null) throw new Error('policy rail gas budget: not a gas amount: ' + need);
    const faucetUnits = sumUnits(faucet.map((holder) => holder.balance));
    const donorUnits = sumUnits(donors.map((donor) => String(donor)));
    const minted = supply ? gasFaucet.units(supply.supply) : null;
    const max = supply ? gasFaucet.units(supply.maxSupply) : null;
    const known = minted !== null && max !== null;
    const mintUnits = known ? (max > minted ? max - minted : 0n) : null;
    const reachable = mintUnits === null ? null : faucetUnits + donorUnits + mintUnits;
    const summary = 'need ' + whole(needUnits) + ' XCHAIN; donors ' + whole(donorUnits) +
        ', faucet ' + whole(faucetUnits) + ' across ' + faucet.length + ' holder(s), MINT headroom ' +
        (mintUnits === null ? 'unreadable' : whole(mintUnits) + ' (supply ' + supply.supply +
            ' of ' + supply.maxSupply + ')');
    if (reachable === null || reachable >= needUnits) return { ok: true, reason: null, summary };
    return {
        ok: false,
        summary,
        reason: 'policy rail bootstrap cannot fund its temporary stakes: ' + summary +
            '; short by ' + whole(needUnits - reachable) + '. The seated cross_chain weight this ' +
            'harness cannot sign for sets the need; refill the gas faucet or clear that weight ' +
            'before re-running.',
    };
}

// Read the three sources off the BTC indexer and plan. `donors` are the donor ledger
// rows' spendable amounts (BigInt or decimal string), already read by the caller.
async function checkBootstrapGas({ db, need, donors, tick = 'XCHAIN', faucetFile = gasFaucet.faucetFile() }) {
    const records = gasFaucet.readFaucetRecords(faucetFile);
    const faucet = records.length ? await gasFaucet.readHolderBalances(db, records, tick) : [];
    const supply = await gasFaucet.readGasSupply(db, tick);
    return planBootstrapGas({ need, faucet, donors, supply });
}

module.exports = { planBootstrapGas, checkBootstrapGas };
