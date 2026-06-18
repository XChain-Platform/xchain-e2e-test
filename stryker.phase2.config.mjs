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
 * Extends Phase 1 by adding integration tests to the test spec.
 * Integration tests exercise connectors and db.js with mock fixtures,
 * catching mutations that unit tests alone may miss.
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
      'test/integration/**/*.test.js',
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
