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
 **********************************************************************
 *
 * XChain End-to-End Test Suite - Environment Configuration
 *
 * Every environment variable the src/ modules read is read here and nowhere
 * else, so the set of knobs a venue can turn is one file long and each
 * default sits beside the coercion that produces it.
 *
 * Every value is a getter, not a resolved constant. The suites set and delete
 * these variables between tests and the connectors used to read them at call
 * time, so a value resolved once at require time would freeze whatever the
 * environment held when the first module loaded this file. A getter keeps the
 * old semantics: the value is whatever the environment says when it is asked.
 *
 * Coercion is carried over verbatim from each old read site, inconsistencies
 * included. The wait tunables honour an explicit 0 while the connect budget
 * treats 0 as unset; unifying them would be a behaviour change, not a move.
 *
 ********************************************************************/

'use strict';

// Parses an integer-valued tunable, falling back to `def` only when the value
// is unset, empty or not a non-negative integer. Plain `parseInt(x) || def`
// swallows an explicit "0" (0 is falsy), which would silently reinstate a wait
// floor a caller asked to disable, so a valid 0 is authoritative here.
function waitTunable(raw, def) {
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : def;
}

module.exports = {
    // Chain network name, handed on raw. The caller falls back to the
    // NETWORK global the mocha setup assigns, so parsing or defaulting here
    // would hide that fallback.
    get NETWORK() { return process.env.NETWORK; },

    // Bulk hub API key. Keyed venues gate writes and getallconfigs behind it;
    // unset on an open venue, in which case no x-api-key header is sent.
    get HUB_API_KEY() { return process.env.HUB_API_KEY; },

    // Key for a call asking for include_secrets. The hub checks that against
    // its credential tier, which falls back to the bulk key when no separate
    // one is set, so this falls back the same way.
    get HUB_SECRETS_API_KEY() { return process.env.HUB_CONFIG_SECRETS_API_KEY || process.env.HUB_API_KEY; },

    // Comma-separated validator hub endpoints, raw. When set it replaces the
    // single host and port below; the connector splits and normalises it.
    get HUB_VALIDATORS() { return process.env.HUB_VALIDATORS; },

    // Single-hub fallback. This suite historically used HUB_URL while the
    // services use HUB_API_HOST, so both spellings are accepted.
    get HUB_HOST() { return process.env.HUB_URL || process.env.HUB_API_HOST || 'localhost'; },
    get HUB_PORT() { return process.env.HUB_PORT || '10000'; },

    // Adaptive-wait tunables for the Database waitFor helpers. Extensions are
    // bounded so a wedged stack still fails, and the lag threshold defaults to
    // zero because any block the indexer has not reached may hold the row.
    get WAIT_MAX_EXTENSIONS() { return waitTunable(process.env.E2E_WAIT_MAX_EXTENSIONS, 3); },
    get WAIT_LAG_BLOCKS() { return waitTunable(process.env.E2E_WAIT_LAG_BLOCKS, 0); },
    get WAIT_LAG_PROBE_MS() { return waitTunable(process.env.E2E_WAIT_LAG_PROBE_MS, 2000); },
    get WAIT_MIN_FOR_EXTENSION() { return waitTunable(process.env.E2E_WAIT_MIN_FOR_EXTENSION, 5000); },

    // How often a long wait samples pipeline progress, the floor on that
    // interval, and how recently rows must have landed to count as still
    // writing.
    get WAIT_PROBE_INTERVAL_MS() { return waitTunable(process.env.E2E_WAIT_PROBE_INTERVAL_MS, 10000); },
    get WAIT_PROBE_MIN_MS() { return waitTunable(process.env.E2E_WAIT_PROBE_MIN_MS, 1000); },
    get WAIT_WRITE_IDLE_MS() { return waitTunable(process.env.E2E_WAIT_WRITE_IDLE_MS, 20000); },

    // Connect-retry budget, bounded by both an attempt count and a wall-clock
    // deadline because an instantly refusing pool burns attempts while an
    // unreachable host burns time. Here 0 falls back to the default.
    get CONNECT_MAX_ATTEMPTS() { return parseInt(process.env.E2E_DB_CONNECT_ATTEMPTS) || 10; },
    get CONNECT_BUDGET_MS() { return parseInt(process.env.E2E_DB_CONNECT_BUDGET_MS) || 30000; },
    get CONNECT_RETRY_MS() { return parseInt(process.env.E2E_DB_CONNECT_RETRY_MS) || 1000; },
};
