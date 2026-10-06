'use strict';


/**
 * The source legs a federation finalized MORE THAN ONCE, from `bridge_transfers` rows.
 *
 * WHY THIS IS ASKED SEPARATELY FROM THE INVARIANT. One lock is one transfer is one mint:
 * the escrow on the origin chain pays for exactly one credit on the destination. When that
 * breaks, every arithmetic assertion downstream (the baseline's escrow-equals-supply, AT2's
 * release, AT6's equal read, AT7's totals) fails on a NUMBER, and a number says only that
 * two chains disagree, not which side invented value. This says which source leg was
 * over-finalized and by how much, so a red names the cause.
 *
 * MEASURED ON THE RAIL 2026-09-12 (drive 11), and this is the reading the function exists
 * for: BTC lock action 99 (5 XCHAIN) carried THREE finalized transfers, at snapshot blocks
 * 1017, 1018 and 1019, and action 95 (30 XCHAIN) carried two. 80 XCHAIN locked on BTC had
 * become 120 XCHAIN minted on DOGE. The hub derives `transfer_id` with `snapshot_block`
 * inside the preimage, so the same lock yields a new id at every BTC height, and both
 * dedupes it passes through are keyed on that id or on a row not yet persisted; the
 * follower's `validateTransfer` has no source-uniqueness test at all, so the mesh co-signs
 * the duplicate. A retracted row is not a duplicate: retraction is the fence working.
 *
 * @param {Array} rows - bridge_transfers rows: {src_chain, src_action_index, amount, status,
 *                       transfer_id, snapshot_block}
 * @returns {Array} one entry per over-finalized source leg, empty when every leg is unique
 */
function overFinalizedSourceLegs(rows) {
    const groups = new Map();
    for (const r of (Array.isArray(rows) ? rows : [])) {
        if (!r) continue;
        if (String(r.status || '') === 'retracted') continue;
        const key = String(r.src_chain) + ':' + String(r.src_action_index);
        const g = groups.get(key) || { srcChain: String(r.src_chain),
            actionIndex: String(r.src_action_index), count: 0, amountTotal: 0, transfers: [] };
        g.count += 1;
        g.amountTotal += Number(r.amount || 0);
        g.transfers.push(String(r.transfer_id).slice(0, 16) + '@' + String(r.snapshot_block));
        groups.set(key, g);
    }
    const dupes = [];
    for (const g of groups.values()) if (g.count > 1) dupes.push(g);
    return dupes;
}

async function overFinalizedSourceLegsByHub(hubs, readHub) {
    const sql = 'SELECT transfer_id, src_chain, src_action_index, amount, status, snapshot_block ' +
        'FROM bridge_transfers';
    const byLeg = new Map();
    let successfulReads = 0;
    let lastError = null;
    for (const hub of (Array.isArray(hubs) ? hubs : [])) {
        let duplicates;
        try {
            duplicates = overFinalizedSourceLegs(await readHub(hub.dbName, sql));
            successfulReads += 1;
        } catch (e) {
            lastError = e;
            continue;
        }
        for (const duplicate of duplicates) {
            const key = duplicate.srcChain + ':' + duplicate.actionIndex;
            const reading = byLeg.get(key);
            if (!reading) {
                byLeg.set(key, { entry: duplicate, hubs: [hub.index] });
                continue;
            }
            reading.hubs.push(hub.index);
            if (duplicate.count > reading.entry.count) reading.entry = duplicate;
        }
    }
    if (!successfulReads && lastError) throw lastError;
    return [...byLeg.values()].map((reading) => Object.assign({}, reading.entry, {
        hubs: reading.hubs.sort((a, b) => Number(a) - Number(b)),
    }));
}

module.exports = { overFinalizedSourceLegs, overFinalizedSourceLegsByHub };
