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

require('./action-messages.fuzz/message_construction_calls.test')
require('./action-messages.fuzz/pipe_delimiter_injection.test')
require('./action-messages.fuzz/null_undefined_nan_coercion.test')
require('./action-messages.fuzz/object_array_coercion.test')
