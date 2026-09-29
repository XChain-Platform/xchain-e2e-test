'use strict';

const DONOR_RESERVE = 10n;

function amount(value, label) {
    const text = String(value);
    if (!/^\d+(?:\.0+)?$/.test(text)) {
        throw new Error(label + ' must be a whole XCHAIN amount, got ' + text);
    }
    return BigInt(text.split('.')[0]);
}

function wholeUnits(value, label) {
    const text = String(value);
    if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error(label + ' is not an XCHAIN amount: ' + text);
    return BigInt(text.split('.')[0]);
}

function planBootstrapFunding(requests, donors, token) {
    const remaining = requests.map((request) => ({
        address: String(request.address),
        amount: amount(request.amount, 'bootstrap request'),
    }));
    const transfers = [];

    const ranked = donors
        .map((donor) => ({ donor, available: wholeUnits(donor.balance, 'donor balance') - DONOR_RESERVE }))
        .filter((entry) => entry.available > 0n)
        .sort((a, b) => (a.available === b.available ? 0 : (a.available > b.available ? -1 : 1)));

    for (const entry of ranked) {
        if (remaining.every((request) => request.amount <= 0n)) break;
        const donor = entry.donor;
        let available = entry.available;
        const donorTransfers = [];
        for (const request of remaining) {
            if (available <= 0n) break;
            if (request.amount <= 0n) continue;
            const moved = available < request.amount ? available : request.amount;
            donorTransfers.push({
                donorAddress: String(donor.address),
                destination: request.address,
                amount: String(moved),
            });
            request.amount -= moved;
            available -= moved;
        }
        if (available > 0n && remaining.length) {
            const last = donorTransfers[donorTransfers.length - 1];
            if (last) last.amount = String(BigInt(last.amount) + available);
            else donorTransfers.push({
                donorAddress: String(donor.address),
                destination: remaining[0].address,
                amount: String(available),
            });
        }
        transfers.push(...donorTransfers);
    }

    const mints = remaining.filter((request) => request.amount > 0n).map((request) => ({
        address: request.address,
        amount: String(request.amount),
    }));
    const mintTotal = mints.reduce((sum, mint) => sum + BigInt(mint.amount), 0n);
    const supply = wholeUnits(token.supply, 'XCHAIN supply');
    const maxSupply = wholeUnits(token.maxSupply, 'XCHAIN max supply');
    const headroom = maxSupply > supply ? maxSupply - supply : 0n;
    if (mintTotal > headroom) {
        throw new Error('XCHAIN supply headroom is ' + headroom + ' but bootstrap funding still needs ' +
            mintTotal + ' after donor transfers');
    }

    return {
        transfers,
        mints,
        mintTotal: String(mintTotal),
        headroom: String(headroom),
    };
}

// Signing seeds an earlier run recorded for its own staked signers. A pubkey the recorded
// seed does not derive to is dropped, so a corrupt record never claims a signer it cannot be.
function recordedSignerSeeds(entries, pubkeyForSeed) {
    const seeds = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const seedHex = entry && String(entry.signingSeed || '').toLowerCase();
        if (!seedHex || !/^[0-9a-f]{64}$/.test(seedHex)) continue;
        let pubkey;
        try { pubkey = String(pubkeyForSeed(seedHex)).toLowerCase(); } catch (e) { continue; }
        const recorded = String(entry.signingPubkey || '').toLowerCase();
        if (recorded && recorded !== pubkey) continue;
        if (!seeds.has(pubkey)) seeds.set(pubkey, { seedHex, origin: 'recorded bootstrap signer ' + pubkey.slice(0, 16) });
    }
    return seeds;
}

module.exports = { DONOR_RESERVE, planBootstrapFunding, recordedSignerSeeds };
