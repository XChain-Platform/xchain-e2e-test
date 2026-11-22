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
 *********************************************************************/

'use strict'

// The node RPC port the harness should dial.
//
// The hub config reports the node's port as seen from inside the stack
// network (18443 on regtest). A drive running on the host, such as a bridge
// rail drive, reaches the node through a published port instead, and nothing
// listens on 18443 there. An explicit NODE_PORT in the environment therefore
// wins; the hub's value is the fallback only when NODE_PORT is unset or blank.
function hubNodePort(envPort, hubPort){
    if (envPort !== undefined && envPort !== null && String(envPort).trim() !== '') {
        return String(envPort).trim()
    }
    return hubPort
}

module.exports = { hubNodePort }
