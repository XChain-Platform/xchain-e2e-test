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
 * AT4, both halves, as reworded 2026-08-26:
 *
 *   "a post-signing tamper records invalid with the same status string on two
 *    independently replaying nodes, and a validator that signed a PER-ROUND
 *    CONSENSUS CANONICAL (still built and signed, XORACLE-tagged) and a BATCH
 *    canonical (XORACLEB-tagged) at one anchor is NOT slashable"
 *
 * HALF ONE, THE TAMPER. A real federation finalizes a real window, the real
 * OracleBatchSigner collects a real quorum over it and the real OraclePublisher
 * lands one genuinely signed batch on DOGE regtest. This drill then takes THAT
 * wire, corrupts it AFTER the signatures were produced, re-encodes it in the same
 * wire form and lands the corrupt bytes on the same chain from the same funded
 * address. Two nodes then decide the corrupt action independently: the standing
 * stack's own indexer, which saw it arrive live, and a node built from nothing by
 * the AT2 replay rig, which sees it only as a block it walks. THE CLAIM IS
 * CROSS-NODE IDENTITY OF THE REJECTION, not rejection: one node refusing a
 * tampered batch is a parser working, two nodes refusing it with byte-identical
 * status strings is consensus.
 *
 * TWO TAMPERS, AND WHY THE SECOND ONE IS NOT PADDING. The tamper AT4 names is a
 * flipped price digit inside the body, which leaves the batch structurally legal,
 * so it reaches signature verification, fails every signature and is rejected at
 * the quorum gate. On a stake-weighted network that gate's refusal reads
 * `invalid: insufficient signer stake`, WHICH IS THE SAME STRING the still-open
 * price-capability gap produces for a perfectly honest batch. A drill that
 * asserted only on that string could pass while proving nothing, so a second
 * tamper moves the batch header's anchor off the last round's anchor: that breach
 * is caught in the structural rules, before any capability is resolved, and its
 * status can ONLY have come from the tamper. The price-digit tamper's own
 * discrimination assertion is isolated in its own `it()` and WAITS (skips, with
 * the reason printed) if the honest batch on the same chain is still recording
 * the capability-gap string; the cross-node identity assertion never waits.
 *
 * HALF TWO, THE SLASH SAFETY, AND EXACTLY HOW FAR IT IS DRIVEN. A full on-chain
 * SLASH is not drivable here and would not be a stronger claim: SLASH is BTC-only
 * (`slash.js` rejects any other COIN outright, because capability stake is
 * BTC-only) while the batch rail publishes to DOGE, and capability bonds cannot
 * be staked on the venue's chain at all. So this half drives the indexer's REAL
 * `Slash` handler in-process against REAL signed artifacts the venue produced:
 * the per-round canonical built by the hub's OWN producer
 * (`OracleConsensus.buildPriceV0Payload`, reached through `venue.priceCanonical`)
 * and the batch canonical the REAL signing round built, each carrying a signature
 * that a REAL venue validator produced and that `ValidatorIdentity.verify`
 * confirms. Only the DB surface behind the handler is stubbed, and it is stubbed
 * PERMISSIVELY (the offender is in the capability snapshot, has never been
 * slashed, holds a burnable bond), so the only thing that can stop the burn is
 * the equivocation logic itself.
 *
 * THE COUNTERFACTUAL IS THE POINT. A test that shows an honest pair is refused
 * proves nothing unless the same harness burns a bond when it should. So the same
 * two RAW contents, signed by the same real validator, are re-wrapped under ONE
 * shared XORACLE key at the same anchor, which is precisely the world the spec
 * describes before `ENGINE_TAGS.ORACLE_BATCH` existed, and fed to the same
 * handler: it records `valid` and burns the entire bond. That pair of results is
 * AT4's parenthetical driven rather than asserted: the distinct tag is the only
 * thing standing between an honest validator and a full bond burn plus permanent
 * capability disqualification.
 *
 * WHAT IS REAL AND WHAT IS NOT:
 *   REAL     - the PBFT rounds, the peer signing round, the canonical builders in
 *              both repos, the publisher, the encoder, the signature, the DOGE
 *              regtest broadcast, the blocks, both indexers' parsers and their
 *              recorded status strings, the consensus compression module, the
 *              indexer's Slash handler, every Ed25519 key and signature.
 *   NOT REAL - the DB surface behind Slash (stubbed permissively in this file,
 *              see slashHarness), and the SLASH action is never carried on a
 *              chain. Named here rather than implied.
 *
 * ONE VENUE AT A TIME. The venue and the replay rig share a fixed-port disposable
 * MariaDB and one DOGE regtest stack. Run this drill serially, never beside
 * another oracle batch drill.
 ********************************************************************/

require('./oracleBatchTamper.integration.test/01_the_window_produced_one_genuinely_signed_batch.test');
require('./oracleBatchTamper.integration.test/02_both_tampered_wires_landed_in_their_own_blocks.test');
require('./oracleBatchTamper.integration.test/03_the_price_digit_tamper_is_refused_with_the_same_status_on_both_nodes.test');
require('./oracleBatchTamper.integration.test/04_the_header_anchor_tamper_is_refused_with_the_same_status_on_both_nodes.test');
require('./oracleBatchTamper.integration.test/05_the_tamper_not_the_chain_is_what_the_rejection_is_about.test');
require('./oracleBatchTamper.integration.test/06_every_price_action_in_the_tampered_range_reads_the_same_on_both_nodes.test');
require('./oracleBatchTamper.integration.test/07_one_real_validator_signed_both_a_per_round_and_the_batch_canonical.test');
require('./oracleBatchTamper.integration.test/08_that_validator_is_not_slashable.test');
require('./oracleBatchTamper.integration.test/09_the_distinct_tag_is_the_only_thing_preventing_the_burn.test');
