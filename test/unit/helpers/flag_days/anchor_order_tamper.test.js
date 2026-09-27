'use strict';

const assert = require('assert');
const path = require('path');

const { parseAnchorV0 } = require('../../../helpers/anchorVersionHelper');
const {
    reverseSections,
    reverseSectionPairs
} = require('../../../helpers/flag_days/anchor_order_tamper');

const PLATFORM_ROOT = path.resolve(__dirname, '../../../../..');
const VECTORS = require(path.join(
    PLATFORM_ROOT,
    'xchain-hub/test/fixtures/anchor_canonical_vectors.json'
));
const V0 = VECTORS.vectors.v0;

describe('ANCHOR v0 order tamper helper', function () {
    it('reverses complete sections without changing their own bytes', function () {
        const original = parseAnchorV0(V0);
        const reversed = parseAnchorV0(reverseSections(V0));

        assert.deepStrictEqual(reversed.sections, original.sections.slice().reverse());
        assert.deepStrictEqual(reversed.sections[0], original.sections[2]);
        assert.deepStrictEqual(reversed.sections[1], original.sections[1]);
        assert.deepStrictEqual(reversed.sections[2], original.sections[0]);
    });

    it('restores the byte-identical wire after reversing sections twice', function () {
        assert.strictEqual(reverseSections(reverseSections(V0)), V0);
    });

    it('reverses only one section\'s PUBKEY and signature pairs', function () {
        const sectionIndex = 1;
        const original = parseAnchorV0(V0);
        const changed = parseAnchorV0(reverseSectionPairs(V0, sectionIndex));
        const expected = original.sections.map((section, index) => Object.assign({}, section, {
            sigs: index === sectionIndex ? section.sigs.slice().reverse() : section.sigs
        }));

        assert.strictEqual(original.sections[sectionIndex].sigs.length, 2);
        assert.deepStrictEqual(changed.sections, expected);
        assert.strictEqual(changed.publisher, original.publisher);
        assert.deepStrictEqual(changed.attestSigs, original.attestSigs);
    });
});
