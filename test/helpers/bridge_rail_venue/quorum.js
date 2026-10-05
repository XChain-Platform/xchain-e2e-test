'use strict';


/**
 * Which seated keys this harness can sign for, and what share of the stake that buys.
 *
 * PURE, and the reason it is a function rather than a constant: the seated set is read
 * off the chain at drive time and the seeds are derived from the operator's rollcall
 * configuration, so neither side is knowable here. A drive that cannot reach a
 * supermajority must say so BEFORE it broadcasts a lock, because the failure
 * afterwards is indistinguishable from an engine that does not work.
 *
 * @param {Array} seated   `[{pubkey, stake}]` from the capability set, any case
 * @param {Map}   known    pubkey -> {seedHex, origin}, mirrorDrillFixture's `_knownSignerSeeds`
 * @returns {{adopted: Array, unsignable: Array, ourStake: number, totalStake: number,
 *            share: number, supermajority: boolean}}
 */
function selectBridgeSigners(seated, known) {
    const rows = Array.isArray(seated) ? seated : [];
    const haveSeeds = (known && typeof known.get === 'function') ? known : new Map();
    const adopted = [], unsignable = [];
    let ourStake = 0, totalStake = 0;
    for (const row of rows) {
        const pk = String((row && row.pubkey) || '').toLowerCase();
        const stake = Number((row && row.stake) || 0);
        if (!/^[0-9a-f]{64}$/.test(pk)) continue;
        totalStake += Number.isFinite(stake) ? stake : 0;
        const seed = haveSeeds.get(pk);
        if (seed) {
            adopted.push({ pubkeyHex: pk, seedHex: seed.seedHex, origin: seed.origin, stake: stake });
            ourStake += Number.isFinite(stake) ? stake : 0;
        } else {
            unsignable.push({ pubkeyHex: pk, stake: stake });
        }
    }
    // Strictly greater than two thirds, the rule stake_weighted_quorum enforces. Equal
    // to two thirds is NOT a quorum, and rounding it up here would make a venue that
    // cannot finalize look like one that can.
    const share = totalStake > 0 ? ourStake / totalStake : 0;
    return {
        adopted, unsignable, ourStake, totalStake, share,
        supermajority: totalStake > 0 && ourStake * 3 > totalStake * 2
    };
}

/**
 * Can this harness bring its own quorum, and if not, exactly what is missing?
 *
 * PURE, and it is the single most important function in this file, because the answer
 * changed the shape of this whole row. `selectBridgeSigners` says WHETHER; this says
 * WHY in the words the next reader needs, and it returns a reason rather than throwing
 * so a suite can skip with the blocker named instead of failing thirty minutes later on
 * a round that was never going to close.
 *
 * MEASURED 2026-09-12 ON THE RAIL. All four capability sets on BTC regtest (cross_chain,
 * price, oracle_publish, attestation) hold the same five keys at block 597: the four
 * roster keys at 50000 each and the standing hub's at 10000. The seated four were staked
 * on 2026-09-08 by `test/tools/reseed_attestation_roster.test.js`, which draws from
 * `_knownSignerSeeds()`, and they are idle generations 0 to 3 of the venue's seeding
 * mnemonic. `_knownSignerSeeds()` reproduces them ONLY when
 * `XC_ROLLCALL_FEDERATION_MNEMONIC` is in the environment: it sweeps generations 0 to
 * IDLE_GENERATION_SCAN off that one value, and with the variable absent it holds four
 * keys (three fixed federation signing seeds and the legacy fixed idle seed), none of
 * them seated. Both readings were taken on the rail, minutes apart, with nothing but
 * that variable different: 0 of 210000 staked units without it, 200000 of 210000 with
 * it.
 *
 * SO THE FAILURE THIS GATE CATCHES IS A DRIVE THAT WAS NOT GIVEN THE SECRET, and the
 * remedy is to source it from the operator's own 0600 store into the drive's
 * environment. The value is never named, quoted or defaulted anywhere in this tree, and
 * a drive must not echo it, log it or pass it on a command line. The alternative, if the
 * operator would rather not hand it over at all, is for the roll-call lane to unstake
 * those four keys so a derivable set can be seated instead; that is the operator's call
 * and not this lane's.
 *
 * @param {Array} seated  the capability set, `[{pubkey, weight|stake}]`
 * @param {Map}   known   pubkey -> {seedHex, origin}
 * @returns {{ok: boolean, reason: (string|null), signers: object}}
 */
function resolveVenueQuorum(seated, known) {
    const normalised = (Array.isArray(seated) ? seated : []).map((r) => ({
        pubkey: String((r && r.pubkey) || '').toLowerCase(),
        stake: Number((r && (r.stake !== undefined ? r.stake : r.weight)) || 0),
    }));
    const signers = selectBridgeSigners(normalised, known);
    if (signers.totalStake <= 0) {
        return { ok: false, signers, reason:
            'the bridge capability set is EMPTY or unreadable, so no quorum can be resolved at all' };
    }
    if (!signers.supermajority) {
        const held = signers.adopted.map((a) => a.pubkeyHex.slice(0, 16)).join(', ') || 'none';
        const missing = signers.unsignable.map((u) => u.pubkeyHex.slice(0, 16) + '@' + u.stake).join(', ');
        return { ok: false, signers, reason:
            'this harness can sign for ' + signers.ourStake + ' of ' + signers.totalStake +
            ' staked units in the bridge capability set (' +
            (signers.share * 100).toFixed(1) + ' percent), which is not the stake-weighted ' +
            'supermajority a bridge transfer needs. Holds: ' + held + '. Cannot sign for: ' + missing +
            '. Supply XC_ROLLCALL_FEDERATION_MNEMONIC (with XC_ROLLCALL_IDLE_GENERATION) or ' +
            'XC_ROLLCALL_IDLE_SEED to the drive so the seated keys can be derived, or have the ' +
            'roll-call lane unstake them so a derivable set can be seated. Refusing to broadcast ' +
            'a lock that no federation here can finalize.' };
    }
    return { ok: true, reason: null, signers };
}

/**
 * The SMALLEST set of adopted signers that still clears the stake-weighted supermajority.
 *
 * PURE, and it exists because of a divergence measured on the rail 2026-09-12 rather than
 * for tidiness. With four hubs holding 200000 of 210000, a round closes on any THREE of
 * them, and the fourth then holds no record of it: transfer `2764c037` finalized
 * `BTC:99 -> DOGE 5 XCHAIN (3 sigs)` and hubs 1, 2 and 3 each wrote the `bridge_transfers`
 * row while hub 0 wrote nothing, logged nothing, and never re-proposed the leg. That is
 * fatal to a drive rather than merely untidy, because an indexer mirrors exactly ONE hub:
 * the venue DOGE indexer followed hub 0, so the transfer the federation had agreed could
 * never reach the destination at all.
 *
 * Running the venue on the minimum quorum instead makes every finalizing round unanimous:
 * three hubs at 50000 each clear two thirds of 210000 only if all three sign, so a round
 * that closes has written the row on every hub in the mesh and whichever one an indexer
 * follows carries it. The cost is that the venue no longer tolerates a faulty hub, and that
 * is the right trade for a drive: a stalled round is visible in the log, a hub that quietly
 * diverges is not.
 *
 * Highest stake first, so the set is the smallest possible and is deterministic; ties break
 * on the pubkey so two processes reading the same capability set build the same mesh.
 *
 * @param {Array} adopted `[{pubkeyHex, seedHex, stake}]` from selectBridgeSigners
 * @param {number} totalStake the whole capability set's stake, including keys we cannot sign for
 * @returns {Array} the prefix that clears the supermajority, or [] when none does
 */
function minimalQuorumSigners(adopted, totalStake) {
    const rows = (Array.isArray(adopted) ? adopted.slice() : []).sort((a, b) => {
        const d = Number(b.stake || 0) - Number(a.stake || 0);
        return d !== 0 ? d : String(a.pubkeyHex).localeCompare(String(b.pubkeyHex));
    });
    const total = Number(totalStake || 0);
    let held = 0;
    for (let i = 0; i < rows.length; i++) {
        held += Number(rows[i].stake || 0);
        if (total > 0 && held * 3 > total * 2) return rows.slice(0, i + 1);
    }
    return [];
}

module.exports = { selectBridgeSigners, resolveVenueQuorum, minimalQuorumSigners };
