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
 * Stryker Mutation Testing: Phase 2 Configuration
 *
 * Extends Phase 1 by adding the STUBBED integration suites to the test spec:
 * the ones under test/integration/<dir>/, which exercise connectors and db.js
 * against mock fixtures and catch mutations unit tests alone may miss. That is
 * the same selection package.json declares as `test:integration:stubbed`.
 *
 * The live suites are deliberately OUT: the top-level test/integration/*.test.js
 * roots AND the same-named test/integration/<root>.test/ directories holding
 * their split parts (the `ignore` below). They provision a Docker MariaDB
 * (test/helpers/disposableHubDb.js) or a regtest rail and skip themselves when
 * it is absent, so including any of them makes this phase's score
 * host-dependent: a Docker-less host silently skips those files and still
 * reports a number. A split part runs in its root's lane, so excluding it here
 * drops it from no lane. Docker also does not survive mutation well here, since
 * disposableHubDb.js is itself in the `mutate` list above, so a mutant of the
 * teardown path leaks containers; and `timeoutMS` below is far under live
 * bring-up, which would score live mutants as timeouts rather than survivors.
 * A live mutation tier, if it is ever wanted, belongs in its own serial config.
 *
 * Usage:
 *   npm run test:mutate:integration
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: [
    'src/**/*.js',
    'test/helpers/**/*.js',
    'test/transactionHelper.js',
    'test/cryptoHelper.js',
  ],
  testRunner: 'mocha',
  mochaOptions: {
    spec: [
      'test/unit/**/*.test.js',
      // Stubbed integration only: the one-directory-deep form skips the top-level
      // live roots, and `ignore` skips their split-part directories.
      'test/integration/*/**/*.test.js',
    ],
    // Same selection as package.json `test:integration:stubbed`, pinned by
    // test/unit/scripts/stubbed_lane_hermetic.test.js.
    ignore: ['test/integration/*.test/**'],
  },
  coverageAnalysis: 'perTest',
  timeoutMS: 60000,
  timeoutFactor: 2.5,
  concurrency: 2,
  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/phase2.html',
  },
  jsonReporter: {
    fileName: 'reports/mutation/phase2.json',
  },
  thresholds: {
    high: 90,
    low: 70,
    break: null,
  },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
}
