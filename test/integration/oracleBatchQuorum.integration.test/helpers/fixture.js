'use strict';

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
 ********************************************************************/

let provider = null;
let registrations = 0;
let completions = 0;
let setupPromise = null;

function provide(value) {
    provider = value;
}

async function setUp(ctx, bind) {
    if (!provider) throw new Error('oracle batch test entry did not load');
    if (!setupPromise) setupPromise = Promise.resolve(provider.setup());
    const available = await setupPromise;
    if (!available) {
        ctx.skip();
        return;
    }
    if (bind) bind(provider.snapshot());
}

async function tearDown() {
    completions += 1;
    if (completions === registrations && provider) await provider.teardown();
}

function install(bind) {
    registrations += 1;
    before(async function () {
        await setUp(this, bind);
    });
    after(async function () {
        await tearDown();
    });
}

module.exports = { provide, install };
