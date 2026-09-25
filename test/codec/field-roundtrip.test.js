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
 * Phase 1a: Field-format round-trip (cross-component property test).
 *
 * The carrier layer (roundtrip.test.js) proves the on-chain envelope is
 * losslessly reversible. THIS layer pins the field contract inside it: for
 * every ACTION x VERSION the indexer accepts, a pipe-delimited string built
 * from named fields must parse back to exactly those fields through the
 * indexer's REAL ingestion steps (the same calls processTransaction makes):
 *
 *   'ACTION|V|f1|f2|...'  -> split('|') -> trim -> shift ACTION (+ alias map)
 *                          -> util.getFormatVersion(params[0])
 *                          -> util.setActionParams(data, params, formats, v)
 *
 * Three protections, mirroring the determinism-baseline pattern:
 *   1. PROPERTY: seeded-PRNG corpora per ACTION x VERSION round-trip exactly
 *      (empty optional fields canonicalize to null; that mapping is pinned).
 *   2. GOLDEN VECTORS: fixtures/field-golden-vectors.json commits one
 *      canonical string + parsed-field map per ACTION x VERSION. Any change to
 *      a committed format string fails here first, at the field level, with
 *      a readable diff (the wire-format tripwire).
 *   3. COVERAGE: every ACTION x VERSION discovered in the indexer source must
 *      have a golden vector, so ADDING a wire format without pinning it also
 *      fails. If that fires on an intended change, regenerate (see below) and
 *      review the fixture diff like a consensus change.
 *
 * Formats are discovered from the indexer SOURCE (this.formats[N] = '...' in
 * src/actions/<action>.js, or src/actions/<action>/index.js for an action that
 * has grown its own directory, + the alias table in src/actions/index.js), so
 * this suite can
 * never drift from the real parser tables. The indexer checkout is resolved
 * from XCHAIN_INDEXER_PATH or the monorepo sibling; the suite skips cleanly
 * when neither is present (standalone CI checkout).
 *
 * Regenerate the golden vectors after an INTENDED wire-format change:
 *   GEN_FIELD_GOLDEN=1 npx mocha --no-config test/codec/field-roundtrip.test/01_field_format_round_trip.test.js
 *
 * Out of scope here: numeric normalization (setNumberFormats), validation
 * semantics, and DB effects. Those are parse-time SEMANTICS, covered by the
 * indexer's own tiers. This layer is purely the wire <-> field mapping.
 */
'use strict';
