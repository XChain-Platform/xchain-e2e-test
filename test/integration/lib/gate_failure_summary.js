'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

function gateFailureSummary(output) {
    const plain = String(output || '').replace(/\u001b\[[0-9;]*m/g, '');
    const failTiers = [...plain.matchAll(/^ci:full ----- (.+?) FAIL \(\d+s\)\s*$/gm)]
        .map((match) => match[1]);
    const redTiersMatch = /^ci:full: RED tiers:.*$/m.exec(plain);
    const failingTitles = [];
    const lines = plain.split(/\r?\n/);
    let failuresRemaining = 0;

    for (let index = 0; index < lines.length; index += 1) {
        const summary = /^\s*(\d+) failing\s*$/.exec(lines[index]);
        if (summary) {
            failuresRemaining += Number(summary[1]);
            continue;
        }
        if (!failuresRemaining) continue;

        const numbered = /^\s*\d+\)\s+(.+?)\s*$/.exec(lines[index]);
        if (!numbered) continue;

        const parts = [numbered[1]];
        while (!parts[parts.length - 1].endsWith(':') && index + 1 < lines.length) {
            const continuation = /^\s+(.+?)\s*$/.exec(lines[index + 1]);
            if (!continuation) break;
            parts.push(continuation[1]);
            index += 1;
        }
        failingTitles.push(parts.join(' '));
        failuresRemaining -= 1;
    }

    return {
        failTiers,
        redTiersLine: redTiersMatch ? redTiersMatch[0] : null,
        failingTitles,
    };
}

module.exports = { gateFailureSummary };
