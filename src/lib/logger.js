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

'use strict';

const LEVEL_METHOD = { debug: 'debug', info: 'log', warn: 'warn', error: 'error' };

function getLogger(name) {
    const prefix = name ? `[${name}] ` : '';
    const write = (level, msg, fields) => {
        const fn = console[LEVEL_METHOD[level]] || console['log'];
        const value = prefix ? `${prefix}${msg}` : msg;
        if (fields && typeof fields === 'object') fn(value, fields);
        else fn(value);
    };
    return {
        debug: (msg, fields) => write('debug', msg, fields),
        info:  (msg, fields) => write('info', msg, fields),
        warn:  (msg, fields) => write('warn', msg, fields),
        error: (msg, fields) => write('error', msg, fields),
    };
}

module.exports = { getLogger };
