// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const fs = require('fs');
const path = require('path');

function hasThreeParameterDeclaration(sourceText){
    const declarations = [
        /\b(?:async\s+)?function\s+getAppliedPolicySnapshot\s*\(([^()]*)\)/g,
        /\b(?:const|let|var)\s+getAppliedPolicySnapshot\s*=\s*(?:async\s*)?\(([^()]*)\)\s*=>/g
    ];

    return declarations.some((pattern) => {
        let match;
        while((match = pattern.exec(sourceText)) !== null){
            const parameters = match[1].split(',').map((parameter) => parameter.trim());
            if(parameters.length === 3 && parameters.every(Boolean)) return true;
        }
        return false;
    });
}

function hasBoundSettleCall(sourceText){
    const call = /\bgetAppliedPolicySnapshot\s*\((?:[^()]|\([^()]*\))*?,\s*ctx\.blockIndex\s*\)/g;
    return call.test(sourceText);
}

function readBarrierBound(bridgesDbText, transferSettleText){
    const reader = hasThreeParameterDeclaration(bridgesDbText)
        && /\bblock_index\s*<=\s*\?/.test(bridgesDbText);
    const settle = hasBoundSettleCall(transferSettleText);
    return { reader, settle, bound: reader && settle };
}

function run(repoRoot){
    const indexerRoot = path.join(repoRoot, 'xchain-indexer');
    const bridgesDbPath = path.join(indexerRoot, 'src', 'db', 'bridges', 'index.js');
    const transferSettlePath = path.join(
        indexerRoot, 'src', 'consensus', 'bridge_settle', 'transfer.js'
    );

    let result;
    try {
        result = readBarrierBound(
            fs.readFileSync(bridgesDbPath, 'utf8'),
            fs.readFileSync(transferSettlePath, 'utf8')
        );
    } catch {
        return 2;
    }

    const yesNo = (value) => value ? 'yes' : 'no';
    console.log('BARRIER_BOUND reader=' + yesNo(result.reader) + ' settle=' + yesNo(result.settle));
    return result.bound ? 0 : 1;
}

if(require.main === module){
    process.exitCode = process.argv.length === 3 ? run(process.argv[2]) : 2;
}

module.exports = { readBarrierBound };
