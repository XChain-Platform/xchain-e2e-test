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
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const WORKFLOW = path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml');

describe('unit job documentation sibling checkout', function () {
    it('checks out xchain-documentation before the unit tier runs', function () {
        const workflow = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'));
        const steps = workflow.jobs.unit.steps;
        const documentationIndex = steps.findIndex((step) => {
            return step.with?.repository === 'XChain-Platform/xchain-documentation'
                && step.with?.path === 'xchain-documentation';
        });
        const unitTierIndex = steps.findIndex((step) => step.name === 'Unit tier');

        assert.notStrictEqual(documentationIndex, -1, 'unit job must check out xchain-documentation');
        assert.notStrictEqual(unitTierIndex, -1, 'unit job must define the Unit tier step');
        assert.ok(documentationIndex < unitTierIndex, 'documentation checkout must precede Unit tier');
    });
});
