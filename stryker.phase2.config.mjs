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
 * The top-level test/integration/*.integration.test.js live suites are
 * deliberately OUT. They provision a Docker MariaDB (test/helpers/disposableHubDb.js)
 * and return null without Docker, so including them made this phase's score
 * host-dependent: a Docker-less host silently skips 34 of the 56 files and still
 * reports a number. Docker also does not survive mutation well here, since
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
      // Stubbed integration only. `test/integration/**` also matches the 34
      // top-level live suites; the one-directory-deep form is the stubbed lane.
      'test/integration/*/**/*.test.js',
    ],
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
