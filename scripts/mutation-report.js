#!/usr/bin/env node
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
/**
 * Mutation Report Generator
 *
 * Parses Stryker JSON output and produces a markdown summary suitable
 * for inclusion in reports/ or pasting into a PR description.
 *
 * Usage:
 *   node scripts/mutation-report.js [path/to/report.json]
 *
 * Defaults to reports/mutation/phase1.json if no argument given.
 */

'use strict'

const fs   = require('fs')
const path = require('path')

const CRITICAL_PATH_PATTERNS = [
  'src/db.js',
  'test/helpers/',
  'test/transactionHelper.js',
  'test/cryptoHelper.js',
]

function isCriticalPath(filePath) {
  return CRITICAL_PATH_PATTERNS.some(p => filePath.includes(p))
}

function statusEmoji(status) {
  switch (status) {
    case 'Killed':          return 'X'
    case 'Survived':        return '!'
    case 'Timeout':         return 'T'
    case 'NoCoverage':      return '-'
    case 'RuntimeError':    return 'E'
    case 'CompileError':    return 'C'
    default:                return '?'
  }
}

// Longest inline snippet a report row carries, before truncation.
const SNIPPET_MAX = 120

// Cut a mutant's pre-mutation text out of `files[path].source`, which the report
// schema requires; `location` is 1-based in line AND column, start inclusive and
// end exclusive. Returns null when extraction is impossible, so misses are countable.
function sliceSource(source, location) {
  if (typeof source !== 'string') return null
  if (!location || !location.start || !location.end) return null

  const { start, end } = location
  if (!(start.line >= 1) || !(start.column >= 1)) return null
  if (!(end.line >= start.line) || !(end.column >= 1)) return null

  const lines = source.split('\n')
  if (end.line > lines.length) return null

  if (start.line === end.line) return lines[start.line - 1].slice(start.column - 1, end.column - 1)

  const out = [lines[start.line - 1].slice(start.column - 1)]
  for (let i = start.line; i < end.line - 1; i++) out.push(lines[i])
  out.push(lines[end.line - 1].slice(0, end.column - 1))
  return out.join('\n')
}

// Flatten a snippet into a single-backtick markdown span: a backtick in the
// source would close the span early, and a newline would break the list item.
function inlineCode(text) {
  if (typeof text !== 'string') return ''
  let flat = text.replace(/\s+/g, ' ').trim().replace(/`/g, "'")
  if (flat.length > SNIPPET_MAX) flat = flat.slice(0, SNIPPET_MAX - 3) + '...'
  return flat
}

// The one mutation-score definition, shared by the per-file rows and the header.
// Denominator is COVERED mutants (Stryker's covered-code score), counted UP from
// Killed/Timeout/Survived so a status added to the schema cannot silently join it.
function coveredScore({ killed, timeout, survived }) {
  const covered = killed + timeout + survived
  return covered > 0 ? ((killed + timeout) / covered * 100).toFixed(1) : 'N/A'
}

function buildReport(report, options = {}) {
  const files  = report.files || {}

  let totalMutants  = 0
  let killed        = 0
  let survived      = 0
  let timeout       = 0
  let noCoverage    = 0
  let runtimeError  = 0
  let compileError  = 0
  let ignored       = 0

  const perFile      = []
  const survivedList = []
  let unextractable  = 0

  for (const [filePath, fileData] of Object.entries(files)) {
    const mutants = fileData.mutants || []
    let fKilled = 0, fSurvived = 0, fTotal = 0, fTimeout = 0, fNoCoverage = 0

    for (const m of mutants) {
      totalMutants++
      fTotal++

      switch (m.status) {
        case 'Killed':       killed++;       fKilled++;    break
        case 'Survived':     survived++;     fSurvived++;  break
        case 'Timeout':      timeout++;      fTimeout++;   break
        case 'NoCoverage':   noCoverage++;   fNoCoverage++; break
        case 'RuntimeError': runtimeError++;               break
        case 'CompileError': compileError++;               break
        case 'Ignored':      ignored++;                    break
      }

      if (m.status === 'Survived') {
        const original = sliceSource(fileData.source, m.location)
        if (original === null) unextractable++

        survivedList.push({
          file: filePath,
          line: m.location && m.location.start ? m.location.start.line : '?',
          mutator: m.mutatorName || 'Unknown',
          original: inlineCode(original),
          replacement: inlineCode(m.replacement),
          priority: isCriticalPath(filePath) ? 'P1' : 'P2',
        })
      }
    }

    if (fTotal > 0) {
      const score = coveredScore({ killed: fKilled, timeout: fTimeout, survived: fSurvived })
      perFile.push({
        file: filePath,
        total: fTotal,
        killed: fKilled,
        survived: fSurvived,
        timeout: fTimeout,
        noCoverage: fNoCoverage,
        score,
        critical: isCriticalPath(filePath),
      })
    }
  }

  const overallScore = coveredScore({ killed, timeout, survived })

  // Critical files first, then worst score first, with 'N/A' last: parseFloat('N/A')
  // is NaN and a NaN comparator leaves the WHOLE ranking undefined, not one row.
  perFile.sort((a, b) => {
    if (a.critical !== b.critical) return a.critical ? -1 : 1
    const aScore = a.score === 'N/A' ? Infinity : parseFloat(a.score)
    const bScore = b.score === 'N/A' ? Infinity : parseFloat(b.score)
    return aScore - bScore
  })

  // Sort survived: P1 first, then by file
  survivedList.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === 'P1' ? -1 : 1
    return a.file.localeCompare(b.file) || a.line - b.line
  })

  const lines = []
  const now = options.date || new Date().toISOString().slice(0, 10)

  lines.push('# Mutation Testing Report')
  lines.push('')
  lines.push(`**Date:** ${now}`)
  lines.push(`**Config:** ${options.config || 'unknown'}`)
  lines.push(`**Overall Mutation Score:** ${overallScore}%`)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push('| Metric | Count |')
  lines.push('|--------|-------|')
  lines.push(`| Total Mutants | ${totalMutants} |`)
  lines.push(`| Killed | ${killed} |`)
  lines.push(`| Survived | ${survived} |`)
  lines.push(`| Timeout | ${timeout} |`)
  lines.push(`| No Coverage | ${noCoverage} |`)
  lines.push(`| Runtime Error | ${runtimeError} |`)
  lines.push(`| Compile Error | ${compileError} |`)
  lines.push(`| Ignored | ${ignored} |`)
  lines.push('')
  lines.push('Scores above and in the table below are Stryker\'s covered-code mutation score: '
    + '`(Killed + Timeout) / (Killed + Timeout + Survived)`. No Coverage, Ignored, Runtime Error '
    + 'and Compile Error mutants are outside the denominator, per-file and overall alike.')
  lines.push('')

  lines.push('## Per-File Scores')
  lines.push('')
  lines.push('| File | Mutants | Killed | Survived | Score | Critical |')
  lines.push('|------|---------|--------|----------|-------|----------|')
  for (const f of perFile) {
    lines.push(`| ${f.file} | ${f.total} | ${f.killed} | ${f.survived} | ${f.score}% | ${f.critical ? 'Yes' : ''} |`)
  }
  lines.push('')

  if (survivedList.length > 0) {
    lines.push('## Survived Mutants')
    lines.push('')
    lines.push('These mutations were NOT detected by the test suite. Each represents a potential gap in assertion coverage.')
    lines.push('')

    for (let i = 0; i < survivedList.length; i++) {
      const s = survivedList[i]
      lines.push(`### ${i + 1}. [${s.priority}] ${s.file}:${s.line}`)
      lines.push('')
      lines.push(`- **Mutator:** ${s.mutator}`)
      if (s.original) lines.push(`- **Original:** \`${s.original}\``)
      if (s.replacement) lines.push(`- **Mutant:** \`${s.replacement}\``)
      lines.push('')
    }
  } else {
    lines.push('## Survived Mutants')
    lines.push('')
    lines.push('None! All mutants were detected by the test suite.')
    lines.push('')
  }

  return {
    md: lines.join('\n'),
    date: now,
    overallScore,
    totals: { totalMutants, killed, survived, timeout, noCoverage, runtimeError, compileError, ignored },
    perFile,
    survivedCount: survivedList.length,
    unextractable,
  }
}

function run() {
  const reportPath = process.argv[2] || path.join('reports', 'mutation', 'phase1.json')

  if (!fs.existsSync(reportPath)) {
    console.error(`Report not found: ${reportPath}`)
    console.error('Run "npm run test:mutate" first to generate the Stryker report.')
    process.exit(1)
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const built  = buildReport(report, { config: path.basename(reportPath, '.json') })

  const outDir = path.join('reports', 'mutation')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

  const outPath = path.join(outDir, `report-${built.date}.md`)
  fs.writeFileSync(outPath, built.md, 'utf8')

  const t = built.totals
  console.log(`Mutation report written to ${outPath}`)
  console.log(`Overall mutation score: ${built.overallScore}%`)
  console.log(`  Killed: ${t.killed}  Survived: ${t.survived}  Timeout: ${t.timeout}  NoCoverage: ${t.noCoverage}`)

  if (t.survived > 0) {
    console.log(`\n${t.survived} survived mutant(s): see report for details.`)
  }

  // Fail loud on schema drift rather than shipping a silently empty Original column.
  if (built.unextractable > 0) {
    console.error(`WARNING: could not extract original source for ${built.unextractable} of `
      + `${built.survivedCount} survived mutant(s) (missing files[].source or usable location).`)
  }
}

module.exports = { sliceSource, inlineCode, coveredScore, buildReport, isCriticalPath, statusEmoji }

if (require.main === module) run()
