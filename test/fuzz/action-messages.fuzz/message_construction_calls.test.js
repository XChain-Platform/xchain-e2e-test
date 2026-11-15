// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const { fc, f, fuzzMessageConstruction } = require('./support/message_construction')

describe('Fuzz: ACTION Message Construction', function () {
    fuzzMessageConstruction('issueHelper', 'sendIssueV0',
        fc.tuple(f, f, f, f, f, f))
    fuzzMessageConstruction('issueHelper', 'sendIssueV1',
        fc.tuple(f, f))
    fuzzMessageConstruction('sendHelper', 'sendSendV0',
        fc.tuple(f, f, f, f))
    fuzzMessageConstruction('sendHelper', 'sendSendV1',
        fc.tuple(f, f, f, f, f, f))
    fuzzMessageConstruction('mintHelper', 'sendMintV0',
        fc.tuple(f, f, f, f))
    fuzzMessageConstruction('broadcastHelper', 'sendBroadcastV0',
        fc.tuple(f, f))
    fuzzMessageConstruction('broadcastHelper', 'sendBroadcastV1',
        fc.tuple(f, f, f, f))
    fuzzMessageConstruction('destroyHelper', 'sendDestroyV0',
        fc.tuple(f, f, f))
    fuzzMessageConstruction('sweepHelper', 'sendSweepV0',
        fc.tuple(f, f, f, f, f, f, f))
    fuzzMessageConstruction('dividendHelper', 'sendDividendV0',
        fc.tuple(f, f, f, f))
    fuzzMessageConstruction('callbackHelper', 'sendCallbackV0',
        fc.tuple(f, f))
    fuzzMessageConstruction('sleepHelper', 'sendSleepV0',
        fc.tuple(f, f))
    fuzzMessageConstruction('addressHelper', 'sendAddressV0',
        fc.tuple(f, f, f))
    fuzzMessageConstruction('linkHelper', 'sendLinkV0',
        fc.tuple(f, f, f, f, f))
    fuzzMessageConstruction('fileHelper', 'sendFileV0',
        fc.tuple(f, f, f, f))
    fuzzMessageConstruction('messageHelper', 'sendMessageV0',
        fc.tuple(f, f))
})
