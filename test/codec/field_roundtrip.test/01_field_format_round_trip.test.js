// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const INDEXER_PATH = process.env.XCHAIN_INDEXER_PATH
    || path.resolve(__dirname, '../../../../xchain-indexer');
const HAVE_INDEXER = fs.existsSync(path.join(INDEXER_PATH, 'src/actions/index.js'));

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'field-golden-vectors.json');
const GEN = process.env.GEN_FIELD_GOLDEN === '1';

function extractFormats(source) {
    const formats = {};
    const re = /this\.formats\[(\d+)\]\s*=\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(source)) !== null) formats[Number(m[1])] = m[2];
    return formats;
}

function discoverActions() {
    const dir = path.join(INDEXER_PATH, 'src/actions');
    const actions = {};
    // An action is EITHER a flat <action>.js OR a directory <action>/index.js
    // holding the handler plus its own helpers. Walking only the flat files
    // would silently drop every action that has grown a directory, and the
    // count assertions below would read that as a removal.
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        let name, file;
        if (ent.isDirectory()) {
            name = ent.name;
            file = path.join(dir, ent.name, 'index.js');
            if (!fs.existsSync(file)) continue;            // not an action directory
        } else if (ent.name.endsWith('.js')) {
            // src/actions/index.js is the action REGISTRY and alias table, not
            // an action; discoverAliases reads it instead.
            if (ent.name === 'index.js') continue;
            name = path.basename(ent.name, '.js');
            file = path.join(dir, ent.name);
        } else {
            continue;
        }
        const formats = extractFormats(fs.readFileSync(file, 'utf8'));
        if (Object.keys(formats).length === 0) continue;   // system-synthesized action, no wire format
        actions[name.toUpperCase()] = formats;
    }
    return actions;
}

/**
 * The alias table has lived in two shapes in the indexer: per-property
 * assignment (`this.actionAliases['X'] = 'Y'`) and, since the fee-quote
 * classifier started sharing it, a module-level `const ACTION_ALIASES = {...}`
 * that the constructor Object.assigns in. Read BOTH shapes: matching only one
 * makes this suite silently discover an empty table, which turns the alias
 * assertion into a false red and the round-trip corpora into an un-aliased
 * parse. The caller asserts the result is non-empty, so a third shape screams
 * rather than passing vacuously.
 */
function discoverAliases() {
    const source = fs.readFileSync(path.join(INDEXER_PATH, 'src/actions/index.js'), 'utf8');
    const aliases = {};

    const assigned = /this\.actionAliases\['([A-Z0-9_]+)'\]\s*=\s*'([A-Z0-9_]+)'/g;
    let m;
    while ((m = assigned.exec(source)) !== null) aliases[m[1]] = m[2];

    const literal = /(?:const|let|var)\s+ACTION_ALIASES\s*=\s*\{([\s\S]*?)\}\s*;/.exec(source);
    if (literal) {
        const pair = /'([A-Z0-9_]+)'\s*:\s*'([A-Z0-9_]+)'/g;
        while ((m = pair.exec(literal[1])) !== null) aliases[m[1]] = m[2];
    }
    return aliases;
}

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

// Deterministic value generation, classed by field name. Values are opaque
// strings to the parser. Classes exist so golden vectors read like real
// actions and so numeric fields exercise precision-shaped strings.
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
 * `sparse` empties a deterministic ~20% of optional fields. The wire allows
 * holes (`..||..`), and the parser must map them to null.
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

let util, actions, aliases;

function loadFormats() {
    process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
    process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
    const Utility = require(path.join(INDEXER_PATH, 'src/utility.js'));
    util = new Utility();
    actions = discoverActions();
    aliases = discoverAliases();
}

function proveFormatTable() {
    const count = Object.values(actions).reduce((n, f) => n + Object.keys(f).length, 0);
    assert.ok(Object.keys(actions).length >= 30, `only ${Object.keys(actions).length} actions discovered`);
    assert.ok(count >= 68, `only ${count} action×version formats discovered`);
    for (const [action, formats] of Object.entries(actions))
        for (const [version, format] of Object.entries(formats))
            assert.ok(format.startsWith('VERSION'), `${action} v${version} format must start with VERSION`);
}

function proveSeededCorpora() {
    for (const [action, formats] of Object.entries(actions)) {
        for (const [rawVersion, format] of Object.entries(formats)) {
            const version = Number(rawVersion);
            for (let run = 0; run < 5; run++) {
                for (const sparse of [false, true]) {
                    const seed = (version + 1) * 100000 + run * 13 + (sparse ? 7 : 0);
                    const vector = buildVector(action, version, format, seed, sparse);
                    const output = ingest(util, vector.string, actions, aliases);
                    assert.ok(!output.error, `${action} v${version} seed=${seed}: ${output.error} for ${vector.string}`);
                    for (const [field, wanted] of Object.entries(vector.expected))
                        assert.strictEqual(output.data[field], wanted,
                            `${action} v${version} seed=${seed} field ${field}: ` +
                            `${JSON.stringify(output.data[field])} !== ${JSON.stringify(wanted)}`);
                }
            }
        }
    }
}

function generateGoldenVectors() {
    const golden = [];
    for (const [action, formats] of Object.entries(actions)) {
        for (const version of Object.keys(formats).map(Number).sort((a, b) => a - b)) {
            const vector = buildVector(action, version, formats[version], (version + 1) * 1000, false);
            golden.push({ action, version, format: formats[version], string: vector.string, fields: vector.expected });
        }
    }
    fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n');
    console.log(`[field-roundtrip] wrote ${golden.length} golden vectors: ${GOLDEN_PATH}`);
}

function proveGoldenVectors() {
    if (GEN) generateGoldenVectors();
    else if (!fs.existsSync(GOLDEN_PATH))
        assert.fail(`committed golden vectors missing at ${GOLDEN_PATH}; a lost golden file must not pass tautologically. ` +
            'Regenerate deliberately with GEN_FIELD_GOLDEN=1 and review the diff before committing it.');
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    for (const item of golden) {
        const formats = actions[item.action];
        assert.ok(formats, `golden action ${item.action} no longer exists in the indexer`);
        assert.strictEqual(formats[item.version], item.format,
            `${item.action} v${item.version}: committed format string changed. If intended, ` +
            'regenerate with GEN_FIELD_GOLDEN=1 and review the fixture diff like a consensus change');
        const output = ingest(util, item.string, actions, aliases);
        assert.ok(!output.error, `${item.action} v${item.version}: ${output.error}`);
        assert.deepStrictEqual(output.data, Object.assign({}, output.data, item.fields),
            `${item.action} v${item.version}: golden string no longer parses to its pinned fields`);
    }
}

function proveGoldenCoverage() {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    const pinned = new Set(golden.map((item) => `${item.action}|${item.version}`));
    const missing = [];
    for (const [action, formats] of Object.entries(actions))
        for (const version of Object.keys(formats))
            if (!pinned.has(`${action}|${version}`)) missing.push(`${action} v${version}`);
    assert.deepStrictEqual(missing, [], 'wire formats with no golden vector (new/uncommitted action formats?): ' +
        missing.join(', ') + '. Pin intended additions with GEN_FIELD_GOLDEN=1');
}

function proveTrailingHoles() {
    const output = ingest(util, 'MINT|0|FLDTOK|600||', actions, aliases);
    assert.ok(!output.error);
    assert.strictEqual(output.data.TICK, 'FLDTOK');
    assert.strictEqual(output.data.AMOUNT, '600');
    for (const field of actions.MINT[0].split('|').slice(3)) assert.strictEqual(output.data[field], null, field);
}

function proveWhitespaceTrimming() {
    const output = ingest(util, ' MINT | 0 | FLDTOK | 600 ', actions, aliases);
    assert.ok(!output.error);
    assert.strictEqual(output.data.TICK, 'FLDTOK');
    assert.strictEqual(output.data.AMOUNT, '600');
}

function proveForwardTolerance() {
    const vector = buildVector('MINT', 0, actions.MINT[0], 4242, false);
    const base = ingest(util, vector.string, actions, aliases);
    const extra = ingest(util, vector.string + '|surplus|fields', actions, aliases);
    assert.ok(!base.error && !extra.error);
    assert.deepStrictEqual(extra.data, base.data);
}

function proveAliases() {
    assert.ok(Object.keys(aliases).length >= 4, 'alias table went missing');
    for (const [alias, canonical] of Object.entries(aliases)) {
        assert.ok(actions[canonical], `alias ${alias} -> ${canonical} which has no formats`);
        const values = actions[canonical][0].split('|').map((field) => valueFor(mulberry32(42), field, 0));
        const output = ingest(util, alias + '|' + values.join('|'), actions, aliases);
        assert.strictEqual(output.action, canonical);
        assert.ok(!output.error, `${alias}: ${output.error}`);
    }
}

function provePipeBehavior() {
    const output = ingest(util, 'ISSUE|0|FLDTOK|1000|100|0|memo with | pipe', actions, aliases);
    assert.ok(!output.error);
    assert.strictEqual(output.data.DESCRIPTION, 'memo with');
}

function registerFieldRoundTripSuite() {
    before(loadFormats);
    it('discovers a sane format table from the indexer source', proveFormatTable);
    it('every ACTION×VERSION round-trips dense and sparse seeded corpora exactly', proveSeededCorpora);
    it('matches the committed golden vectors (field-level wire-format tripwire)', proveGoldenVectors);
    it('every discovered ACTION×VERSION is pinned by a golden vector', proveGoldenCoverage);
    it('trailing holes and missing params both canonicalize to null', proveTrailingHoles);
    it('whitespace around params is trimmed before parsing', proveWhitespaceTrimming);
    it('params beyond the format are ignored (forward-tolerant parse)', proveForwardTolerance);
    it('action aliases resolve to the canonical parser (TRANSFER -> SEND, ...)', proveAliases);
    it('a pipe inside free text corrupts the parse (pinned as a known wire property)', provePipeBehavior);
}

(HAVE_INDEXER ? describe : describe.skip)(
    'Codec field-format round-trip (P1a) @regression @tier1', registerFieldRoundTripSuite);
