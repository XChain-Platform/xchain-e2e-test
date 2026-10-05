'use strict';

const assert = require('assert');

/**
 * The XBRIDGE v0 lock wire, BTC only: `XBRIDGE|0|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO`.
 * PURE. Built here rather than inline in each drive so one typo cannot make one AT
 * pass against a differently shaped action than another.
 */
function lockWireV0(destCoin, destAddress, amount, memo) {
    assert.ok(destCoin && destAddress, 'bridgeRailVenue: a v0 lock needs a destination coin and address');
    return ['XBRIDGE', '0', String(destCoin), String(destAddress), String(amount), String(memo || '')].join('|');
}

/**
 * The XBRIDGE v1 burn wire, non-BTC only: `XBRIDGE|1|BTC_ADDRESS|AMOUNT|MEMO`.
 * PURE.
 */
function burnWireV1(btcAddress, amount, memo) {
    assert.ok(btcAddress, 'bridgeRailVenue: a v1 burn needs a BTC destination address');
    return ['XBRIDGE', '1', String(btcAddress), String(amount), String(memo || '')].join('|');
}

/**
 * The XBRIDGE v3 lock wire, the origin chain of a NATIVE token:
 * `XBRIDGE|3|TICK|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO` (token spec section 5).
 * PURE. The tick is the native spelling, never the rooted `<ORIGIN>.<NAME>` form: a v3
 * naming a rooted tick is exactly the `TICK (not native here)` refusal AT4 drives.
 */
function lockWireV3(tick, destCoin, destAddress, amount, memo) {
    assert.ok(tick && destCoin && destAddress, 'bridgeRailVenue: a v3 lock needs a tick, a destination coin and an address');
    return ['XBRIDGE', '3', String(tick), String(destCoin), String(destAddress), String(amount), String(memo || '')].join('|');
}

/**
 * The XBRIDGE v4 burn wire, the destination chain of a BRIDGED row:
 * `XBRIDGE|4|TICK|ORIGIN_ADDRESS|AMOUNT|MEMO`. The tick is the rooted copy (`BTC.FUFU`)
 * and the origin chain is read off its prefix, which is why the wire carries no coin
 * field: a v4 with one would parse its address as a coin, the v1 trap over again.
 * PURE.
 */
function burnWireV4(tick, originAddress, amount, memo) {
    assert.ok(tick && originAddress, 'bridgeRailVenue: a v4 burn needs a bridged tick and an origin address');
    return ['XBRIDGE', '4', String(tick), String(originAddress), String(amount), String(memo || '')].join('|');
}

/**
 * The issuer opt-in, ISSUE format 7: `ISSUE|7|TICK|BRIDGE_CHAINS|MIN_DEPTH|LOCK_BRIDGE|MEMO`
 * (token spec section 7).
 *
 * PURE. An `undefined` or `null` field is emitted EMPTY, which the handler reads as
 * "unchanged" (issue.js back-fills every empty field from the row), so a caller that
 * only wants to raise MIN_DEPTH passes nothing for the chains and the list survives.
 * `'-'` is the sentinel for "no chains" and is passed through as the string it is; `0`
 * for MIN_DEPTH means "no raise" and must reach the wire as `0`, not as an empty field,
 * which is why the test is on null-ness and never on truthiness.
 */
function optInWire(tick, chains, minDepth, lockBridge, memo) {
    assert.ok(tick, 'bridgeRailVenue: a format 7 opt-in needs a tick');
    const field = (v) => (v === undefined || v === null) ? '' : String(v);
    return ['ISSUE', '7', String(tick), field(chains), field(minDepth), field(lockBridge), String(memo || '')].join('|');
}

/**
 * The depth a lock must reach before the federation signs it: the venue's pinned
 * per-coin depth raised, never lowered, by the origin row's MIN_DEPTH as the lock
 * stamped it (xchain-hub transfer_poll.effectiveDepth, token spec D24).
 *
 * PURE, and a twin of the hub's rule on purpose: AT5's depth leg mines exactly this many
 * blocks past the lock and asserts "not before, and at", so the number the drive waits
 * for must be the number the hub waits for. A non-positive or non-numeric MIN_DEPTH is
 * "no raise", the hub's own reading of `0`.
 */
function effectiveLockDepth(platformDepth, minDepth) {
    let platform = Number(platformDepth);
    if (!Number.isFinite(platform) || platform <= 0) platform = 1;
    const raised = Number(minDepth);
    if (!Number.isFinite(raised) || raised <= 0) return platform;
    return Math.max(platform, raised);
}

/**
 * How a set of finalized legs was applied on the destination, held against the
 * per-block cap and the `(snapshot_block, transfer_id)` order (token spec D29, AT8).
 *
 * PURE. `transfers` are hub `bridge_transfers` rows (transfer_id, snapshot_block);
 * `settlements` are destination `bridge_settlements` rows (transfer_id, block_index).
 * The reading is `ok` only when every transfer was applied, the destination blocks are
 * non-decreasing along the canonical order (a leg applied in an EARLIER block than one
 * that sorts before it is an order break, whatever the counts), and no block carried
 * more than `cap` of them. `groups` is the per-block count in block order, which is
 * what "25 then 5" is a claim about; the caller asserts on it once the destination was
 * held still so the whole set became due together.
 *
 * @returns {{ok: boolean, reason: (string|null), order: string[], groups: Array<{block: number, count: number}>}}
 */
function capOrderReading(transfers, settlements, cap) {
    const limit = Number(cap);
    assert.ok(Number.isInteger(limit) && limit > 0, 'capOrderReading: cap must be a positive integer, got ' + cap);
    const applied = new Map();
    for (const s of settlements || []) applied.set(String(s.transfer_id), Number(s.block_index));
    const order = (transfers || []).slice().sort((a, b) =>
        (Number(a.snapshot_block) - Number(b.snapshot_block)) ||
        (String(a.transfer_id) < String(b.transfer_id) ? -1 : String(a.transfer_id) > String(b.transfer_id) ? 1 : 0))
        .map((t) => String(t.transfer_id));
    const out = { ok: true, reason: null, order: order, groups: [] };
    let lastBlock = -Infinity;
    const perBlock = new Map();
    for (const id of order) {
        const block = applied.get(id);
        if (!Number.isFinite(block)) return Object.assign(out, { ok: false, reason: 'transfer ' + id + ' was never applied' });
        if (block < lastBlock) return Object.assign(out, { ok: false, reason: 'transfer ' + id + ' applied at block ' + block + ' after a leg that sorts before it applied at ' + lastBlock });
        lastBlock = block;
        perBlock.set(block, (perBlock.get(block) || 0) + 1);
    }
    out.groups = [...perBlock.keys()].sort((a, b) => a - b).map((block) => ({ block: block, count: perBlock.get(block) }));
    const over = out.groups.find((g) => g.count > limit);
    if (over) return Object.assign(out, { ok: false, reason: 'block ' + over.block + ' applied ' + over.count + ' legs, over the cap of ' + limit });
    return out;
}

/**
 * The policy-inheritance wires the policy rail drive broadcasts (policy spec sections 3 to 6),
 * one builder each so no two legs can spell one action two ways. PURE. Field orders are the
 * indexer's own format strings: LIST 0 `VERSION|TYPE|MEMO|ITEM...`, LIST 1
 * `VERSION|EDIT|LIST_ACTION_INDEX|MEMO|ITEM...` (EDIT 1 adds, 2 removes), ISSUE 5
 * `VERSION|TICK|ALLOW_LIST|BLOCK_LIST|MEMO`, ISSUE 6
 * `VERSION|TICK|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO`, SLEEP 1
 * `VERSION|RESUME_BLOCK|TICK|MEMO`, SEND 0 `VERSION|TICK|AMOUNT|DESTINATION|MEMO`.
 */
const POLICY_LIST_EDIT = { ADD: 1, REMOVE: 2 };

function listCreateWire(type, items, memo) {
    assert.ok(Array.isArray(items), 'bridgeRailVenue: a LIST create needs an item array');
    return ['LIST', '0', String(type), String(memo || '')].concat(items.map(String)).join('|');
}

function listEditWire(edit, listIndex, items, memo) {
    assert.ok(Object.values(POLICY_LIST_EDIT).includes(Number(edit)), 'bridgeRailVenue: LIST edit must be 1 (add) or 2 (remove), got ' + edit);
    assert.ok(Array.isArray(items) && items.length, 'bridgeRailVenue: a LIST edit needs at least one item');
    return ['LIST', '1', String(edit), String(listIndex), String(memo || '')].concat(items.map(String)).join('|');
}

function policyListsWire(tick, allowList, blockList, memo) {
    const field = (v) => (v === undefined || v === null) ? '' : String(v);
    return ['ISSUE', '5', String(tick), field(allowList), field(blockList), String(memo || '')].join('|');
}

function controllerBindWire(tick, controller, actionClass, cooldown, memo) {
    return ['ISSUE', '6', String(tick), String(controller), String(actionClass), String(cooldown || 0), '0', String(memo || '')].join('|');
}

function sleepTickWire(tick, resumeBlock, memo) {
    return ['SLEEP', '1', String(resumeBlock), String(tick), String(memo || '')].join('|');
}

function sendWireV0(tick, amount, destination, memo) {
    return ['SEND', '0', String(tick), String(amount), String(destination), String(memo || '')].join('|');
}

/**
 * The order a destination applies due policy snapshots in: `(snapshot_block, snapshot_id)`
 * across ticks, `policy_seq` within one, with each tick group ranked by its LOWEST
 * snapshot_id inside the block so two ticks never interleave.
 *
 * PURE, and a twin of xchain-indexer src/consensus/bridge_settle/pass.js
 * duePolicySnapshots on purpose: policy AT8's cap leg asserts "5 then 1 in the pinned
 * order", so the order the drive holds the ledger to must be the one the indexer applies.
 *
 * @param {Array} rows  policy_snapshots rows (snapshot_id, snapshot_block, origin_chain, tick, policy_seq)
 * @returns {Array<string>} snapshot ids in apply order
 */
function policyDueOrder(rows) {
    const list = (rows || []).slice();
    const groupRank = new Map();
    for (const r of list) {
        const key = String(r.origin_chain) + '|' + String(r.tick);
        const prev = groupRank.get(key);
        const sid = String(r.snapshot_id);
        if (prev === undefined || sid < prev) groupRank.set(key, sid);
    }
    list.sort((a, b) => {
        const ba = Number(a.snapshot_block), bb = Number(b.snapshot_block);
        if (ba !== bb) return ba - bb;
        const ka = String(a.origin_chain) + '|' + String(a.tick);
        const kb = String(b.origin_chain) + '|' + String(b.tick);
        if (ka !== kb) {
            const ra = groupRank.get(ka), rb = groupRank.get(kb);
            if (ra !== rb) return ra < rb ? -1 : 1;
            return ka < kb ? -1 : 1;
        }
        return Number(a.policy_seq) - Number(b.policy_seq);
    });
    return list.map((r) => String(r.snapshot_id));
}

/**
 * How a set of finalized policy snapshots was applied, held against the per-block cap and the
 * pinned order (policy spec section 6, AT8). PURE; `capOrderReading`'s reading over the policy
 * order, with the destination's `bridge_settlements` rows (`transfer_id` = snapshot_id,
 * `block_index`, `action_index`) as the record. Within one block the settlement action
 * indexes must also rise along the order, since five snapshots in one block is a claim about
 * their sequence and not only their count.
 *
 * @returns {{ok: boolean, reason: (string|null), order: string[], groups: Array<{block: number, count: number}>}}
 */
function policyCapOrderReading(snapshots, settlements, cap) {
    const limit = Number(cap);
    assert.ok(Number.isInteger(limit) && limit > 0, 'policyCapOrderReading: cap must be a positive integer, got ' + cap);
    const applied = new Map();
    for (const s of settlements || []) {
        applied.set(String(s.transfer_id), { block: Number(s.block_index), index: Number(s.action_index) });
    }
    const order = policyDueOrder(snapshots);
    const out = { ok: true, reason: null, order: order, groups: [] };
    let last = { block: -Infinity, index: -Infinity };
    const perBlock = new Map();
    for (const id of order) {
        const at = applied.get(id);
        if (!at || !Number.isFinite(at.block)) return Object.assign(out, { ok: false, reason: 'snapshot ' + id + ' was never applied' });
        if (at.block < last.block || (at.block === last.block && at.index <= last.index)) {
            return Object.assign(out, { ok: false, reason: 'snapshot ' + id + ' applied at block ' + at.block + ' index ' + at.index +
                ', not after the snapshot that sorts before it (block ' + last.block + ' index ' + last.index + ')' });
        }
        last = at;
        perBlock.set(at.block, (perBlock.get(at.block) || 0) + 1);
    }
    out.groups = [...perBlock.keys()].sort((a, b) => a - b).map((block) => ({ block: block, count: perBlock.get(block) }));
    const over = out.groups.find((g) => g.count > limit);
    if (over) return Object.assign(out, { ok: false, reason: 'block ' + over.block + ' applied ' + over.count + ' snapshots, over the cap of ' + limit });
    return out;
}

/**
 * Each hub's OWN origin-indexer endpoint, as a per-hub environment overlay.
 *
 * PURE. The production federation runs one indexer per coin beside every hub: the node
 * installer points each indexer's `HUB_API_URL` at its co-located hub and each hub's
 * `<COIN>_INDEXER_URL` at its co-located indexer (xchain-node
 * src/services/config_service.js). Two consensus rules depend on that shape, and a venue
 * that hands every hub one shared indexer silently breaks both:
 *   a follower co-signs a reorg retraction only when ITS OWN indexer pushed the matching
 *     `pushbridgereorg` (xchain-hub src/consensus/retraction/cosign.js, the local intent);
 *     a single venue indexer pushes to the hub it follows and to no other, so the
 *     retraction never reaches quorum and every mirror refuses it unsigned (token rail
 *     drive 24, row 355e35e2);
 *   a follower co-signs a policy snapshot only when its own `gettokenpolicy` read agrees,
 *     and a follower whose origin indexer is unreachable abstains (policy spec section 3).
 *
 * @param {Array} indexers  venue indexer records, `{followsHub, apiUrl}`
 * @param {string} chain    the chain code the URLs serve, e.g. `BTC`
 * @param {object} [overrides]  `{hubIndex: url}` replacing a hub's endpoint (a drill's
 *                          unreachable indexer); a hub no indexer follows gets only these
 * @returns {object} `{hubIndex: {<CHAIN>_INDEXER_URL: url}}`
 */

module.exports = { lockWireV0, burnWireV1, lockWireV3, burnWireV4, optInWire, effectiveLockDepth, capOrderReading, POLICY_LIST_EDIT, listCreateWire, listEditWire, policyListsWire, controllerBindWire, sleepTickWire, sendWireV0, policyDueOrder, policyCapOrderReading };
