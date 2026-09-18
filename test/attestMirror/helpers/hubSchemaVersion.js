'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * The mirror schema version, read from the indexer that consumes the mirror
 * rather than typed into a leg.
 *
 * WHY THIS IS NOT A LITERAL. A hub serving a schema version the mirror consumer
 * does not demand parks the WHOLE mirror rather than one table, so every leg that
 * reads a snapshot route wants the same number, and that number moves with the
 * schema. A leg carrying its own copy goes stale silently at the next bump and
 * then fails for a reason that has nothing to do with what it is testing: the
 * 2026-09-18 aggregate lost `at0b` to a hardcoded 5 against a hub serving 7,
 * while `venue.smoke`, which already read the indexer's copy, stayed green
 * through the same bump.
 *
 * WHAT IT READS. The indexer's own `hub_schema_version.js`, resolved beside the
 * e2e repo. The indexer renamed the file to snake_case, so the hyphenated name an
 * older indexer origin carries is tried too and the first that exists wins; when
 * neither exists the snake_case path is returned so the require throws naming the
 * path it wanted rather than a bare undefined.
 ********************************************************************/

const fs = require('fs')
const path = require('path')

const CANDIDATE_NAMES = ['hub_schema_version.js', 'hub-schema-version.js']

const HUB_SCHEMA_VERSION_FILE = CANDIDATE_NAMES
    .map((name) => path.join(__dirname, '..', '..', '..', '..', 'xchain-indexer', 'src', 'hub', name))
    .find((p) => fs.existsSync(p)) ||
    path.join(__dirname, '..', '..', '..', '..', 'xchain-indexer', 'src', 'hub', 'hub_schema_version.js')

const HUB_SCHEMA_VERSION = require(HUB_SCHEMA_VERSION_FILE).HUB_SCHEMA_VERSION

module.exports = { HUB_SCHEMA_VERSION, HUB_SCHEMA_VERSION_FILE }
