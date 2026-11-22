// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

function expectedFoldRows(bundle) {
    const chainRows = bundle.sections.map((section, sectionIndex) => ({
        section_index: sectionIndex,
        chain: section.chain,
        checkpoint_seq: section.checkpoint_seq
    }))
    const archiveRow = bundle.archive_count === 0 ? null : {
        section_index: bundle.sections.length,
        match_batch_seq: bundle.match_batch_seq,
        match_count: bundle.match_count,
        batch_crc32: bundle.batch_crc32,
        total_chunks: bundle.total_chunks
    }

    return { chainRows, archiveRow }
}

module.exports = { expectedFoldRows }
