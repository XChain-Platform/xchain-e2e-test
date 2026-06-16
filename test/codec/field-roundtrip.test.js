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
 * Phase 1a — Field-format round-trip (cross-component property test).
 *
 * The carrier layer (roundtrip.test.js) proves the on-chain envelope is
 * losslessly reversible. THIS layer pins the field contract inside it: for
 * every ACTION × VERSION the indexer accepts, a pipe-delimited string built
 * from named fields must parse back to exactly those fields through the
 * indexer's REAL ingestion steps (the same calls processTransaction makes):
 *
 *   'ACTION|V|f1|f2|…'  → split('|') → trim → shift ACTION (+ alias map)
 *                        → util.getFormatVersion(params[0])
 *                        → util.setActionParams(data, params, formats, v)
 *
 * Three protections, mirroring the determinism-baseline pattern:
 *   1. PROPERTY — seeded-PRNG corpora per ACTION×VERSION round-trip exactly
 *      (empty optional fields canonicalize to null; that mapping is pinned).
 *   2. GOLDEN VECTORS — fixtures/field-golden-vectors.json commits one
 *      canonical string + parsed-field map per ACTION×VERSION. Any change to
 *      a committed format string fails here first, at the field level, with
 *      a readable diff — the wire-format tripwire.
 *   3. COVERAGE — every ACTION×VERSION discovered in the indexer source must
 *      have a golden vector, so ADDING a wire format without pinning it also
 *      fails. If that fires on an intended change, regenerate (see below) and
 *      review the fixture diff like a consensus change.
 *
 * Formats are discovered from the indexer SOURCE (this.formats[N] = '…' in
 * src/actions/*.js + the alias table in src/actions.js), so this suite can
 * never drift from the real parser tables. The indexer checkout is resolved
 * from XCHAIN_INDEXER_PATH or the monorepo sibling; the suite skips cleanly
 * when neither is present (standalone CI checkout).
 *
 * Regenerate the golden vectors after an INTENDED wire-format change:
 *   GEN_FIELD_GOLDEN=1 npx mocha --no-config test/codec/field-roundtrip.test.js
 *
 * Out of scope here: numeric normalization (setNumberFormats), validation
 * semantics, and DB effects — those are parse-time SEMANTICS, covered by the
 * indexer's own tiers. This layer is purely the wire ↔ field mapping.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// --- Resolve the indexer checkout (env override, then monorepo sibling). ---
const INDEXER_PATH = process.env.XCHAIN_INDEXER_PATH
    || path.resolve(__dirname, '../../../xchain-indexer');
const HAVE_INDEXER = fs.existsSync(path.join(INDEXER_PATH, 'src/actions.js'));

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'field-golden-vectors.json');
const GEN = process.env.GEN_FIELD_GOLDEN === '1';

// ---------------------------------------------------------------------------
// Discovery — extract the parser's own format tables from the indexer source.
// ---------------------------------------------------------------------------

/** All `this.formats[N] = '…'` declarations in one action file. */
function extractFormats(source) {
    const formats = {};
    const re = /this\.formats\[(\d+)\]\s*=\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(source)) !== null) formats[Number(m[1])] = m[2];
    return formats;
}

/** Map of ACTION name → { version → format string }, from src/actions/*.js. */
function discoverActions() {
    const dir = path.join(INDEXER_PATH, 'src/actions');
    const actions = {};
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
        const formats = extractFormats(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (Object.keys(formats).length === 0) continue;   // system-synthesized action, no wire format
        actions[path.basename(file, '.js').toUpperCase()] = formats;
    }
    return actions;
}

/** The alias table (`this.actionAliases['X'] = 'Y'`) from src/actions.js. */
function discoverAliases() {
    const source = fs.readFileSync(path.join(INDEXER_PATH, 'src/actions.js'), 'utf8');
    const aliases = {};
    const re = /this\.actionAliases\['([A-Z0-9_]+)'\]\s*=\s*'([A-Z0-9_]+)'/g;
    let m;
    while ((m = re.exec(source)) !== null) aliases[m[1]] = m[2];
    return aliases;
}

// ---------------------------------------------------------------------------
// The system under test — the indexer's REAL ingestion steps, in order.
// ---------------------------------------------------------------------------

/** Mirror processTransaction's param pipeline up to the parsed field map. */
function ingest(util, actionString, formatsByAction, aliases) {
    const params = String(actionString).split('|');
    params.forEach((v, i) => { params[i] = String(v).trim(); });
    let action = String(params.shift()).toUpperCase();
    if (aliases[action]) action = aliases[action];
    const formats = formatsByAction[action];
    if (!formats) return { action, error: 'unknown action' };
    const version = util.getFormatVersion(params[0]);
    if (version === null || formats[version] === undefined)
        return { action, error: 'unknown version' };
    const data = util.setActionParams({}, params, formats, version);
    return { action, version, data };
}

// ---------------------------------------------------------------------------
// Deterministic value generation, classed by field name. Values are opaque
// strings to the parser — classes exist so golden vectors read like real
// actions and so numeric fields exercise precision-shaped strings.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

const ADDRESSES = [
    'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD',
    'n4nbVcRRR5sEHyp2VYuLUvCyDmQmBoonoK',
    'mvuKWKvgzrkxh8QgNZ91vMBZUKN5BFYmo3',
];
const AMOUNTS = ['0', '1', '600', '10.5', '12345678901234567890', '1.234567890123456789'];
const INTS    = ['0', '1', '100', '4761388'];
const TICKS   = ['FLDTOK', 'XCHAIN', 'FLD.SUB', 'A1B2C3'];

function valueFor(rng, field, version) {
    if (field === 'VERSION') return String(version);
    if (/PUBKEY/.test(field)) return '02' + 'ab'.repeat(32);
    if (/ADDRESS|DESTINATION|SOURCE|RECIPIENT/.test(field)) return pick(rng, ADDRESSES);
    if (/TICK|PARENT/.test(field)) return pick(rng, TICKS);
    if (/MEMO|DESCRIPTION/.test(field)) return 'field round trip ' + Math.floor(rng() * 1e6);
    if (/URL|URI/.test(field)) return 'https://example.test/x' + Math.floor(rng() * 1e6);
    if (/CODE|HEX|DATA|PAYLOAD|HASH|SIG/.test(field)) {
        let s = '';
        for (let i = 0; i < 16; i++) s += '0123456789abcdef'[Math.floor(rng() * 16)];
        return s;
    }
    if (/^LOCK_|^ALLOW_|_LIST$|^TRANSFER$|OWNERSHIP/.test(field)) return pick(rng, ['0', '1']);
    if (/BLOCK|SLEEP|EXPIRE|DEADLINE|COOLDOWN|INDEX|COUNT|LIMIT|START|STOP|DECIMALS|VOUT/.test(field))
        return pick(rng, INTS);
    if (/AMOUNT|SUPPLY|MAX|FEE|PRICE|RATE|RATIO|ESCROW|MINT/.test(field)) return pick(rng, AMOUNTS);
    return 'V' + Math.floor(rng() * 1e9).toString(36).toUpperCase();
}

/**
 * One deterministic corpus entry for (action, version, format).
 * `sparse` empties a deterministic ~20% of optional fields — the wire allows
 * holes (`…||…`), and the parser must map them to null.
 */
function buildVector(action, version, format, seed, sparse) {
    const rng = mulberry32(seed);
    const fields = format.split('|');
    const values = fields.map(f => {
        const v = valueFor(rng, f, version);
        return (sparse && f !== 'VERSION' && rng() < 0.2) ? '' : v;
    });
    const expected = {};
    fields.forEach((f, i) => { expected[f] = values[i] === '' ? null : values[i]; });
    return { string: action + '|' + values.join('|'), expected };
}

// ---------------------------------------------------------------------------

(HAVE_INDEXER ? describe : describe.skip)('Codec field-format round-trip (P1a) @regression @tier1', function () {

    let util, actions, aliases;

    before(function () {
        process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
        process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
        const Utility = require(path.join(INDEXER_PATH, 'src/utility.js'));
        util = new Utility();
        actions = discoverActions();
        aliases = discoverAliases();
    });

    it('discovers a sane format table from the indexer source', function () {
        // 31 wire actions / 70 action×version formats at origin/master 2026-06-12;
        // thresholds sit just below so removals scream but additions don't.
        const count = Object.values(actions).reduce((n, f) => n + Object.keys(f).length, 0);
        assert.ok(Object.keys(actions).length >= 30, `only ${Object.keys(actions).length} actions discovered`);
        assert.ok(count >= 68, `only ${count} action×version formats discovered`);
        for (const [action, formats] of Object.entries(actions))
            for (const [v, fmt] of Object.entries(formats))
                assert.ok(fmt.startsWith('VERSION'), `${action} v${v} format must start with VERSION`);
    });

    it('every ACTION×VERSION round-trips dense and sparse seeded corpora exactly', function () {
        for (const [action, formats] of Object.entries(actions)) {
            for (const [v, format] of Object.entries(formats)) {
                const version = Number(v);
                for (let run = 0; run < 5; run++) {
                    for (const sparse of [false, true]) {
                        const seed = (version + 1) * 100000 + run * 13 + (sparse ? 7 : 0);
                        const vec = buildVector(action, version, format, seed, sparse);
                        const out = ingest(util, vec.string, actions, aliases);
                        assert.ok(!out.error,
                            `${action} v${version} seed=${seed}: ${out.error} for ${vec.string}`);
                        for (const [field, want] of Object.entries(vec.expected)) {
                            assert.strictEqual(out.data[field], want,
                                `${action} v${version} seed=${seed} field ${field}: ` +
                                `${JSON.stringify(out.data[field])} !== ${JSON.stringify(want)}`);
                        }
                    }
                }
            }
        }
    });

    it('matches the committed golden vectors (field-level wire-format tripwire)', function () {
        if (GEN || !fs.existsSync(GOLDEN_PATH)) {
            const golden = [];
            for (const [action, formats] of Object.entries(actions)) {
                for (const v of Object.keys(formats).map(Number).sort((a, b) => a - b)) {
                    const vec = buildVector(action, v, formats[v], (v + 1) * 1000, false);
                    golden.push({ action, version: v, format: formats[v],
                                  string: vec.string, fields: vec.expected });
                }
            }
            fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
            fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n');
            console.log(`[field-roundtrip] wrote ${golden.length} golden vectors: ${GOLDEN_PATH}`);
        }

        const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
        for (const g of golden) {
            const formats = actions[g.action];
            assert.ok(formats, `golden action ${g.action} no longer exists in the indexer`);
            assert.strictEqual(formats[g.version], g.format,
                `${g.action} v${g.version}: committed format string changed — if intended, ` +
                'regenerate with GEN_FIELD_GOLDEN=1 and review the fixture diff like a consensus change');
            const out = ingest(util, g.string, actions, aliases);
            assert.ok(!out.error, `${g.action} v${g.version}: ${out.error}`);
            assert.deepStrictEqual(out.data, Object.assign({}, out.data, g.fields),
                `${g.action} v${g.version}: golden string no longer parses to its pinned fields`);
        }
    });

    it('every discovered ACTION×VERSION is pinned by a golden vector', function () {
        const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
        const pinned = new Set(golden.map(g => `${g.action}|${g.version}`));
        const missing = [];
        for (const [action, formats] of Object.entries(actions))
            for (const v of Object.keys(formats))
                if (!pinned.has(`${action}|${v}`)) missing.push(`${action} v${v}`);
        assert.deepStrictEqual(missing, [],
            'wire formats with no golden vector (new/uncommitted action formats?): ' +
            missing.join(', ') + ' — pin intended additions with GEN_FIELD_GOLDEN=1');
    });

    // --- Pinned edge semantics of the ingestion pipeline itself. ---

    it('trailing holes and missing params both canonicalize to null', function () {
        const out = ingest(util, 'MINT|0|FLDTOK|600||', actions, aliases);
        assert.ok(!out.error);
        assert.strictEqual(out.data['TICK'], 'FLDTOK');
        assert.strictEqual(out.data['AMOUNT'], '600');
        const fields = actions['MINT'][0].split('|');
        for (const f of fields.slice(3)) assert.strictEqual(out.data[f], null, f);
    });

    it('whitespace around params is trimmed before parsing', function () {
        const out = ingest(util, ' MINT | 0 | FLDTOK | 600 ', actions, aliases);
        assert.ok(!out.error);
        assert.strictEqual(out.data['TICK'], 'FLDTOK');
        assert.strictEqual(out.data['AMOUNT'], '600');
    });

    it('params beyond the format are ignored (forward-tolerant parse)', function () {
        // Fill EVERY field of MINT v0, then append surplus params past the format.
        const vec   = buildVector('MINT', 0, actions['MINT'][0], 4242, false);
        const base  = ingest(util, vec.string, actions, aliases);
        const extra = ingest(util, vec.string + '|surplus|fields', actions, aliases);
        assert.ok(!base.error && !extra.error);
        assert.deepStrictEqual(extra.data, base.data);
    });

    it('action aliases resolve to the canonical parser (TRANSFER → SEND, …)', function () {
        assert.ok(Object.keys(aliases).length >= 4, 'alias table went missing');
        for (const [alias, canonical] of Object.entries(aliases)) {
            assert.ok(actions[canonical], `alias ${alias} → ${canonical} which has no formats`);
            const fmtFields = actions[canonical][0].split('|');
            // Build a minimal v0 string under the alias; it must parse via the target's formats.
            const values = fmtFields.map(f => valueFor(mulberry32(42), f, 0));
            const out = ingest(util, alias + '|' + values.join('|'), actions, aliases);
            assert.strictEqual(out.action, canonical);
            assert.ok(!out.error, `${alias}: ${out.error}`);
        }
    });

    it('a pipe inside free text corrupts the parse — pinned as a known wire property', function () {
        // The wire has no escaping: '|' is ALWAYS a delimiter. Builders (sdk,
        // e2e helpers, wallet) must reject or strip it from free-text fields.
        const out = ingest(util, 'ISSUE|0|FLDTOK|1000|100|0|memo with | pipe', actions, aliases);
        assert.ok(!out.error);
        assert.strictEqual(out.data['DESCRIPTION'], 'memo with');   // truncated at the pipe
    });
});
