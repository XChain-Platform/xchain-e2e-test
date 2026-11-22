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
 * XPOLICY: a hub-signed token-policy snapshot applied to a bridged copy, end to end.
 *
 * Policy spec acceptance tests AT1 (first snapshot materialized), AT2 (an issuer edit
 * reaching the copy), AT4 (falsification), AT5's ordering half and AT6 (sleep), driven on
 * the multiHubCrossSettleE2E shape: the record one repository finalizes is handed to the
 * other repository's real apply path.
 *
 * THE BINDING UNDER TEST is narrower and sharper than the transfer one. Membership is
 * TRANSPORT: the allow and block arrays ride beside the row and are bound to it only
 * through policy_hash, so the hub's policyHash and the indexer's policyHash are a
 * byte-match obligation over a canonical membership text, and the canonical they are
 * committed inside is a second one. If either drifts, a snapshot the whole federation
 * signed is refused by every destination, permanently, while both repositories' own suites
 * stay green. Every hash and every signature below is produced by xchain-hub's engine and
 * verified by xchain-indexer's settle pass.
 *
 * The apply cases need no venue. The federated case boots a real MultiValidatorHub mesh,
 * needs a hub MariaDB (provisioned HUB_DB_* or Docker), and skips loudly without one. The
 * live origin-to-destination lag readout on the rail is spec row 15's, not this
 * file's.
 ********************************************************************/

'use strict';

// Run the split parts in this suite's lane; the stubbed lane ignores their directory.
require('./bridgePolicyE2E.integration.test/01_cross_repository_seam.test');
require('./bridgePolicyE2E.integration.test/02_at1_first_snapshot.test');
require('./bridgePolicyE2E.integration.test/03_at2_edit_and_at6_sleep.test');
require('./bridgePolicyE2E.integration.test/04_at4_falsification.test');
require('./bridgePolicyE2E.integration.test/05_at5_apply_order.test');
require('./bridgePolicyE2E.integration.test/06_federation_produces_snapshot.test');
