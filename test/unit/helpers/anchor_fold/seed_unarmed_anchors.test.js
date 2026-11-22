'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');

const { seededVersions } = require('../../../helpers/anchor_fold/seed_unarmed_anchors');

describe('AF4 unarmed anchor seed versions', function () {
    it('needs a v0 bundle and a v1 or v2 archive before AF4 may replay', function () {
        const of = (...versions) => seededVersions(versions.map((v) => ({ payload: 'ANCHOR|' + v + '|x' })));
        assert.deepStrictEqual(of(0, 1), { bundle: true, archive: true });
        assert.deepStrictEqual(of(0, 2), { bundle: true, archive: true });
        assert.deepStrictEqual(of(0), { bundle: true, archive: false });
        assert.deepStrictEqual(of(1, 2), { bundle: false, archive: true });
        assert.deepStrictEqual(of(3), { bundle: false, archive: false });
        assert.deepStrictEqual(seededVersions([{ payload: 'XLIST|0|x' }, { payload: null }]),
            { bundle: false, archive: false });
    });
});
