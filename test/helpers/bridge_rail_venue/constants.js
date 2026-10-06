'use strict';


// The four chains the hub engine knows, as the hub spells them. Kept local rather
// than imported from the hub so a unit run needs no hub module on NODE_PATH.
const BRIDGE_CHAINS = ['BTC', 'DOGE', 'LTC'];

// The rail's pinned depth. Spec section 15 names 1 for AT1 and AT2's first run; AT2's
// second run raises DOGE to 60 to measure the real wait, which is why this is a
// parameter of the venue rather than a constant of the drive.
const DEFAULT_CONFIRMATIONS = { BTC: 1, DOGE: 1, LTC: 1 };

// How often the engine polls each chain's indexer for confirmed legs.
//
// AND IT IS THE HUB'S OWN DEFAULT, NOT A FASTER ONE, because "lowering a poll cadence
// changes no verdict" turned out to be false and the measurement is worth keeping. At 3000
// ms a single XBRIDGE v0 lock of 5 XCHAIN (BTC action_index 103) was finalized FIVE times
// under five different transfer_ids and minted five times on DOGE to
// mrN1X35cW5rjfNwFZJKcQL6rGVnB5Pwn7j: 25 units against 5 units of escrow, measured
// 2026-09-12 on drive 10. The hub derives `transfer_id` from the moving `snapshot_block`
// and dedupes a source leg only by `bridgeTransferExistsForSource`, checked BEFORE the
// round; a poll shorter than a round therefore starts several rounds on one leg before the
// first row exists, and each closes under its own id. The destination's idempotency key is
// the transfer_id, so it cannot tell the five apart.
//
// The defect is the hub's and is reported as such; this constant simply stops the venue
// from manufacturing it. A drive pays about a minute more per leg for the honesty.
const DEFAULT_POLL_MS = 15000;

// The venue's price seeds. `SEED_ROUND_BASE` is the synthetic round space
// attestMirrorVenue._seedHubPrices writes its bring-up rows in (9000001, 9000002); a reseed
// writes the next unused round ABOVE it, because getLatestPrice takes the highest round for
// a pair and a real oracle round on regtest sits in the tens of thousands. `COIN_USD_SEED`
// is the COIN/USD value that seed uses, kept identical here so a reseeded fee prices exactly
// like the bring-up one did. Neither is a round the sentinel clearer has to know: these
// hub databases are stamped per run and dropped with it.
const SEED_ROUND_BASE = 9000000;
const COIN_USD_SEED   = '100000.00000000';

module.exports = { BRIDGE_CHAINS, DEFAULT_CONFIRMATIONS, DEFAULT_POLL_MS, SEED_ROUND_BASE, COIN_USD_SEED };
