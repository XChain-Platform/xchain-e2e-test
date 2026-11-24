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

// The e2e harness runs from a checkout that may be shared or mounted, so a
// dependency bump in package.json is not live until `npm ci` runs there.
// The legacy spend helper passes BigInt output values to bitcoinjs-lib, which
// only bitcoinjs-lib 7.x accepts; a stale 6.x install fails every legacy spend
// with "cannot write a non-number as a number". This guards both the install
// and the behaviour that depends on it.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const root = path.join(__dirname, '..', '..', '..');

function major(spec) {
  const m = /(\d+)\.\d+\.\d+/.exec(String(spec));
  assert.ok(m, `cannot read a version from "${spec}"`);
  return Number(m[1]);
}

describe('installed dependency drift', function () {
  it('installed bitcoinjs-lib major matches the declared major', function () {
    const declared  = require(path.join(root, 'package.json')).dependencies['bitcoinjs-lib'];
    const installed = JSON.parse(fs.readFileSync(
      path.join(root, 'node_modules', 'bitcoinjs-lib', 'package.json'), 'utf8')).version;
    assert.strictEqual(major(installed), major(declared),
      `bitcoinjs-lib ${installed} is installed but package.json declares ${declared}; run npm ci in xchain-e2e-test`);
  });

  it('serializes a legacy P2PKH output with a BigInt value', function () {
    const bitcoin = require('bitcoinjs-lib');
    const tx = new bitcoin.Transaction();
    tx.addInput(Buffer.alloc(32), 0);
    tx.outs.push({
      script: Buffer.from('76a914' + '00'.repeat(20) + '88ac', 'hex'),
      value:  1000n,
    });
    assert.doesNotThrow(() => tx.toHex(),
      'BigInt output values must serialize; reinstall dependencies with npm ci');
  });
});
