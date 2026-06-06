/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Stryker Mutation Testing — Phase 1 Configuration
 *
 * Targets test infrastructure (src/ connectors, test/helpers/, transactionHelper,
 * cryptoHelper) and runs unit tests to detect mutations.
 *
 * Usage:
 *   npm run test:mutate            # full mutation run
 *   npm run test:mutate:dry-run    # verify config without mutations
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
    spec: ['test/unit/**/*.test.js'],
  },
  coverageAnalysis: 'perTest',
  timeoutMS: 30000,
  timeoutFactor: 2.5,
  concurrency: 4,
  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/phase1.html',
  },
  jsonReporter: {
    fileName: 'reports/mutation/phase1.json',
  },
  thresholds: {
    high: 90,
    low: 70,
    break: null,
  },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
}
