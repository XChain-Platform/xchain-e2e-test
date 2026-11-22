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
 *
 * Whether an error is the encoder's NO_UTXOS refusal: the tracker had not yet
 * indexed the change output a previous transaction left, which a short wait and
 * a rebuild clears. The stale-UTXO retry predicates key on this reason rather
 * than on message text or the generic -32603, which every unrelated encoder
 * fault also returns. Three shapes carry it:
 *
 *   src/XChainEncoderConnector.js    err.rpcReason          (JSON-RPC data.reason)
 *   SDK EncoderClient refusal        err.details.context.reason
 *   SDK pre-check of an empty address err.code
 *
 ********************************************************************/

'use strict'

const NO_UTXOS = 'NO_UTXOS'

function isNoUtxosRefusal(err) {
    if (!err || typeof err !== 'object') return false
    if (err.rpcReason === NO_UTXOS || err.code === NO_UTXOS) return true
    const context = err.details && err.details.context
    return Boolean(context && context.reason === NO_UTXOS)
}

module.exports = { NO_UTXOS, isNoUtxosRefusal }
