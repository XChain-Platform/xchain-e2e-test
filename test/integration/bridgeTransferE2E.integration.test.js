/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 * XBRIDGE transfer: a hub-signed record applied by the indexer settle pass, end to end.
 *
 * Base spec acceptance tests AT1 (lock to mint), AT2 (burn to escrow release), AT4
 * (falsification) and the token spec's AT1, AT2 and AT5 (tick and decimals binding),
 * driven as far as a venue-free harness can drive them. The shape is
 * multiHubCrossSettleE2E's: a record that one repository FINALIZES is handed to the other
 * repository's real apply path, so the two halves of a consensus rule are proven to agree.
 *
 * WHY THIS EXISTS BESIDE THE INDEXER'S OWN bridge_settle SUITE. That suite signs its
 * fixtures over bridge_settle.js's OWN canonical, so it proves the module is
 * self-consistent and can say nothing about the hub. The hub's engine suite has the mirror
 * image of the same blind spot. The canonical is a cross-repository byte-match obligation
 * forever: the day the two drift, every transfer on the platform stops verifying while
 * both suites stay green. Every record below is derived and signed with xchain-hub's
 * CrossChainBridgeEngine and ValidatorIdentity and verified by xchain-indexer's settle
 * pass, which is the only place that drift is visible.
 *
 * WHAT RUNS WHERE.
 *   - The cross-repo and apply cases need no chain rail, no indexer and no hub database.
 *     They run wherever the two sibling repositories are checked out.
 *   - The federated case boots a real MultiValidatorHub mesh, which needs a hub MariaDB
 *     (provisioned HUB_DB_* or Docker) and skips loudly without one. It is the only case
 *     here that exercises PBFT itself; the rest exercise what PBFT produces.
 *
 * The end-to-end AT1/AT2 readouts on the BTC/DOGE regtest rail (real locks,
 * real confirmations, real mirror) are spec row 15 and are NOT claimed by this file.
 ********************************************************************/

'use strict';

'use strict';

// Run the split parts in this suite's lane; the stubbed lane ignores their directory.
require('./bridgeTransferE2E.integration.test/01_cross_repository_seam.test');
require('./bridgeTransferE2E.integration.test/02_base_at1_in_leg_mints.test');
require('./bridgeTransferE2E.integration.test/03_base_at2_out_leg_releases.test');
require('./bridgeTransferE2E.integration.test/04_base_at4_falsification.test');
require('./bridgeTransferE2E.integration.test/05_token_at1_at2_at5.test');
require('./bridgeTransferE2E.integration.test/06_federation_client_and_pending_read.test');
require('./bridgeTransferE2E.integration.test/07_federation_produces_record.test');
