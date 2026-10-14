'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The AT6 wake composes RESUME_BLOCK from the BTC tip. At tip+1 a broadcast slower than one
// cadence block grades stale on every try, so the wake must compose with a wider margin.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const FILE = path.resolve(__dirname, '..', '..', 'integration', 'bridge_rail_policy.test',
    '06_at6_the_origin_sleep_reaches_the_copy.test.js');
const text = fs.readFileSync(FILE, 'utf8');

describe('policy AT6 wake RESUME_BLOCK margin', function () {
    it('declares a margin of at least two blocks', function () {
        const m = /const WAKE_RESUME_MARGIN = (\d+);/.exec(text);
        assert.ok(m, 'WAKE_RESUME_MARGIN is not declared');
        assert.ok(Number(m[1]) >= 2, 'the margin ' + m[1] + ' is no wider than tip+1');
    });

    it('composes the resume block from the tip plus the margin, never tip+1', function () {
        assert.ok(/getBlockCount\(\)\) \+ WAKE_RESUME_MARGIN;/.test(text), 'the resume block does not use the margin');
        assert.ok(!/getBlockCount\(\)\) \+ 1;/.test(text), 'a tip+1 resume block remains');
    });

    it('re-reads the tip on every retry', function () {
        const loop = text.split('for (let send = 0')[1].split('return { wake, attempts }')[0];
        assert.ok(loop.includes('getBlockCount()'), 'the tip is not re-read inside the retry loop');
    });
});
