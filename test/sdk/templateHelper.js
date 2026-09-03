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
 * XChain Platform E2E - contract-template source loader
 *
 * The template drills under test/sdk/ deploy the REAL sources from the
 * xchain-contracts library. Locating a template and stripping its comments
 * are the same job in every one of those suites, and the unit tier needs the
 * identical bytes to size a deploy plan without a live stack, so both live
 * here rather than copied per suite.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

// Candidate roots for an xchain-contracts checkout, most specific first. The
// bundled copy under test/sdk/_contracts is what survives into the e2e-test
// container image, which carries no sibling checkouts.
function templateCandidates(name) {
    const rel = path.join(name, name + '.js');
    return [
        path.resolve(__dirname, '_contracts', rel),
        process.env.XCHAIN_CONTRACTS_DIR && path.join(process.env.XCHAIN_CONTRACTS_DIR, rel),
        path.resolve(__dirname, '../../../xchain-contracts', rel),
        path.resolve(__dirname, '../../../../xchain-contracts', rel),
        process.env.HOME && path.join(process.env.HOME, 'xchain-modules-src/xchain-contracts', rel),
        process.env.HOME && path.join(process.env.HOME, 'Sites/XChain-Platform/xchain-contracts', rel),
    ].filter(Boolean);
}

// Read a template's source, or throw naming every path that was tried. Callers
// in a before() hook turn that into a suite skip with a readable reason.
function loadTemplate(name) {
    const candidates = templateCandidates(name);
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8'); } catch (e) { /* keep trying */ }
    }
    throw new Error('Could not locate xchain-contracts/' + name + '/' + name + '.js' +
        '. Set XCHAIN_CONTRACTS_DIR to the xchain-contracts checkout. Tried:\n  ' + candidates.join('\n  '));
}

// Strip comments and blank lines so the DEPLOY payload carries only code.
// String/char-aware: a `//` inside a string literal is not a comment, and a
// backslash escape never ends the literal it sits in. Indentation goes too;
// the VM only ever sees this compacted form, so it is what gets hashed,
// chunked and deployed.
function compactSource(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    let state = 'code';
    while (i < n) {
        const c = src[i], d = src[i + 1];
        if (state === 'code') {
            if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
            if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
            if (c === "'") { state = 'sq'; out += c; i++; continue; }
            if (c === '"') { state = 'dq'; out += c; i++; continue; }
            if (c === '`') { state = 'tpl'; out += c; i++; continue; }
            out += c; i++; continue;
        }
        if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
        if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; i += 2; } else i++; continue; }
        if (c === '\\') { out += c + (d || ''); i += 2; continue; }
        if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) state = 'code';
        out += c; i++;
    }
    return out.split('\n').map(l => l.replace(/^\s+/, '').replace(/\s+$/, '')).filter(l => l.length > 0).join('\n');
}

// Convenience: the exact bytes a template drill deploys.
function loadCompactTemplate(name) {
    return compactSource(loadTemplate(name));
}

module.exports = {
    templateCandidates,
    loadTemplate,
    compactSource,
    loadCompactTemplate,
};
