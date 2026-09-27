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

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const SUITE_FILE = path.join(__dirname, 'suite_parses.test.js');

describe('full-tree parse scan timeout', function () {

    it('allows at least ten seconds for the parse scan', function () {
        const source = fs.readFileSync(SUITE_FILE, 'utf8');
        const callback = source.match(
            /it\(\s*['"]finds no file that node could not load['"]\s*,\s*function\s*\(\s*\)\s*\{([\s\S]*?)^[ \t]{4}\}\);/m
        );

        assert(callback, 'could not find the full-tree parse scan callback');

        const timeout = callback[1].match(/\bthis\.timeout\(\s*(\d+)\s*\)/);
        assert(timeout, 'the full-tree parse scan callback must call this.timeout()');
        assert(Number(timeout[1]) >= 10000,
            'the full-tree parse scan timeout must be at least 10000ms');
    });
});
