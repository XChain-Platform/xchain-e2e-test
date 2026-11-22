'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const SNAPSHOT_COMPARE_KEYS = ['round_number', 'coin_pair', 'price', 'block_timestamp', 'reference_block'];

// Guards every identifier this file interpolates into SQL. Database and table
// names cannot be parameterized, so the only safe posture is to refuse anything
// that is not a plain identifier rather than to escape it.
const SAFE_IDENT = /^[A-Za-z0-9_]+$/;

// Names the replay's databases inside the platform hub account's only CREATE grant,
// `XChain\_%\_MVH\_%` (as attestMirrorVenue's DB_PREFIX does); a name outside it is
// refused with MariaDB 1044. MariaDB caps a database name at 64 characters.
const REPLAY_DB_PREFIX = 'XChain_AT2_MVH_';

// Maps { PRICE: 5, BRIDGE: 0 } to HUB_SYNC_PRICE_GRACE_S=5 and HUB_SYNC_BRIDGE_GRACE_S=0,
// refusing a name or value the indexer could not have meant.
function watermarkGraceEnv(graces) {
    const env = {};
    for (const [name, value] of Object.entries(graces || {})) {
        if (!/^[A-Z][A-Z_]*$/.test(name) || !Number.isSafeInteger(value) || value < 0)
            throw new Error('oracleBatchReplay: watermark grace ' + name + '=' + value + ' is not NAME=<whole seconds>');
        env['HUB_SYNC_' + name + '_GRACE_S'] = String(value);
    }
    return env;
}
function replayDbNames(label, stamp) {
    const base = REPLAY_DB_PREFIX + label + '_' + stamp;
    const names = { hub: base + '_Hub', indexer: base + '_Indexer', mirror: base + '_HubMirror' };
    for (const name of Object.values(names)) {
        if (!SAFE_IDENT.test(name) || name.length > 64)
            throw new Error('oracleBatchReplay: replay database name ' + name + ' is not a plain identifier of at most 64 characters');
    }
    return names;
}

// Coin name to the three-letter code every per-chain env var and database name
// is keyed on. Same map chainRail carries; kept local so this rig can build a
// node without entering a rail.
const COIN_CODE_MAP = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' };
function coinCode(coin) {
    return COIN_CODE_MAP[coin] || String(coin).toUpperCase().slice(0, 3);
}

// How long a node has to boot far enough to answer. Covers the hub's schema
// bootstrap plus the indexer's verifyTables/runMigrations on an empty database,
// which is where most of it goes.

function ident(name, what) {
    if (!SAFE_IDENT.test(String(name || ''))) {
        throw new Error('oracleBatchReplay: refusing to interpolate an unsafe ' + what + ': ' + name);
    }
    return String(name);
}

module.exports = {
    SNAPSHOT_COMPARE_KEYS, replayDbNames, watermarkGraceEnv, coinCode, ident
}
