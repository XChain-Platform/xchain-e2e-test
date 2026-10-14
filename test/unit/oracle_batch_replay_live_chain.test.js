'use strict';

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
 * The AT2 rig's EXPLICIT live-chain override, and the barrier drill's env
 * contract, pinned without a chain, a database or a hub.
 *
 * WHY THIS EXISTS. The override's whole reason for being is a host whose
 * standing hub cannot be asked: `_resolveLiveChain` normally dials
 * XChainHubConnector and calls `getAllConfig`, an auth-gated read, and on such a
 * host that call fails and no node can be built at all. An override that
 * "worked" but still dialled the hub would pass every integration run on a
 * machine that HAS a hub and fail only on the one machine it was written for, so
 * the assertion here is not "the shape came back" but "the connector was never
 * constructed".
 *
 * The second half is the launcher's contract. Every endpoint the drill needs
 * arrives by environment-variable NAME, is read once, and is then invisible
 * inside a child process: a variable exported under the wrong name degrades into
 * a node that indexes nothing, hours later, which is indistinguishable from the
 * barrier result the drill exists to measure. So the composition is pure and
 * pinned here, and a missing variable is named rather than defaulted.
 *
 * The cases live in oracle_batch_replay_live_chain.test/, one part per
 * topic; the fixtures they share are in its helpers/fixtures.js.
 ********************************************************************/

const DIR = './oracle_batch_replay_live_chain.test/';

module.exports = {};

require(DIR + '01_live_chain_override.test.js');
require(DIR + '02_credential_path.test.js');
require(DIR + '03_launcher_env_contract.test.js');
