'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

describe('[regression:p0] Service Connectors', function () {

    afterEach(function () {
        require('./connectors.regression/support/environment').sinon.restore()
    })

    require('./connectors.regression/blockchain_connector.test')
    require('./connectors.regression/utxo_tracker_connector.test')
    require('./connectors.regression/encoder_connector.test')
    require('./connectors.regression/indexer_connector_ping.test')
    require('./connectors.regression/indexer_connector_call_envelope.test')
    require('./connectors.regression/hub_connector_config_failover.test')
    require('./connectors.regression/hub_connector_parse_endpoints.test')
    require('./connectors.regression/regtest_miner_connector_calls.test')
    require('./connectors.regression/regtest_miner_connector_errors.test')
    require('./connectors.regression/constructor_url_building.test')
    require('./connectors.regression/rpc_unwrap_falsy_passthrough.test')
})
