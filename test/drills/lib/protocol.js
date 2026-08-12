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
 * Wire protocol between the drill harness and a remote drill validator.
 *
 * One newline-delimited JSON object per line, each tagged with a sentinel.
 * The tag exists because the transport is the child's STDOUT, which is also
 * where the hub writes its own logs and where ssh writes banners and warnings:
 * without a tag the parser would choke on the first `Warning: Permanently
 * added ... to the list of known hosts`.
 ********************************************************************/

'use strict';

const TAG = '@XCDRILL@';

function encode(obj) {
    return TAG + ' ' + JSON.stringify(obj) + '\n';
}

// Returns the decoded object, or null for any line that is not drill traffic
// (hub logs, ssh banners, stack traces). Malformed drill lines return null
// too rather than throwing: one corrupt line must not kill a running drill.
function decodeLine(line) {
    if (typeof line !== 'string') return null;
    const at = line.indexOf(TAG);
    if (at === -1) return null;
    const body = line.slice(at + TAG.length).trim();
    if (!body) return null;
    try {
        const obj = JSON.parse(body);
        return (obj && typeof obj === 'object') ? obj : null;
    } catch (e) {
        return null;
    }
}

// Incremental splitter for a stream that arrives in arbitrary chunks. Holds
// the trailing partial line until its newline shows up.
class LineSplitter {
    constructor() { this.buf = ''; }
    push(chunk) {
        this.buf += String(chunk);
        const parts = this.buf.split('\n');
        this.buf = parts.pop();
        return parts;
    }
    flush() {
        const rest = this.buf;
        this.buf = '';
        return rest ? [rest] : [];
    }
}

module.exports = { TAG, encode, decodeLine, LineSplitter };
