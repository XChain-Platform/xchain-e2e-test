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

function run() {
  const reportPath = process.argv[2] || path.join('reports', 'mutation', 'phase1.json')

  if (!fs.existsSync(reportPath)) {
    console.error(`Report not found: ${reportPath}`)
    console.error('Run "npm run test:mutate" first to generate the Stryker report.')
    process.exit(1)
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
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
        survivedList.push({
          file: filePath,
          line: m.location ? m.location.start.line : '?',
          mutator: m.mutatorName || 'Unknown',
          original: m.originalLines || '',
          replacement: m.replacement || m.mutatedLines || '',
          priority: isCriticalPath(filePath) ? 'P1' : 'P2',
        })
      }
    }

    if (fTotal > 0) {
      const detectable = fTotal - fNoCoverage
      const score = detectable > 0
        ? ((fKilled + fTimeout) / detectable * 100).toFixed(1)
        : 'N/A'
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

  const detectable  = totalMutants - noCoverage - ignored
  const overallScore = detectable > 0
    ? ((killed + timeout) / detectable * 100).toFixed(1)
    : 'N/A'

  // Sort: critical files first, then by score ascending (worst first)
  perFile.sort((a, b) => {
    if (a.critical !== b.critical) return a.critical ? -1 : 1
    return parseFloat(a.score) - parseFloat(b.score)
  })

  // Sort survived: P1 first, then by file
  survivedList.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === 'P1' ? -1 : 1
    return a.file.localeCompare(b.file) || a.line - b.line
  })

  // Build markdown
  const lines = []
  const now = new Date().toISOString().slice(0, 10)

  lines.push('# Mutation Testing Report')
  lines.push('')
  lines.push(`**Date:** ${now}`)
  lines.push(`**Config:** ${path.basename(reportPath, '.json')}`)
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

  const md = lines.join('\n')

  // Write to reports/mutation/
  const outDir = path.join('reports', 'mutation')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

  const outPath = path.join(outDir, `report-${now}.md`)
  fs.writeFileSync(outPath, md, 'utf8')
  console.log(`Mutation report written to ${outPath}`)
  console.log(`Overall mutation score: ${overallScore}%`)
  console.log(`  Killed: ${killed}  Survived: ${survived}  Timeout: ${timeout}  NoCoverage: ${noCoverage}`)

  if (survived > 0) {
    console.log(`\n${survived} survived mutant(s): see report for details.`)
  }
}

run()
