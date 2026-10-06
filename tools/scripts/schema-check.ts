#!/usr/bin/env tsx
/**
 * Schema check: ensure all @colyseus/schema classes live in contract/realtime/
 * and no duplicates exist elsewhere in the codebase.
 *
 * Usage: pnpm schema:check
 * Exit 0 if clean, 1 if duplicates found.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '../..');

// Directories to scan for schema violations
const SCAN_DIRS = [
  join(REPO_ROOT, 'server'),
  join(REPO_ROOT, 'tools'),
];

// Known schema class names that must only exist in contract/realtime/
const SCHEMA_CLASSES = [
  'PlayerState',
  'NpcState',
  'CoinState',
  'VenueState',
  'MarketState',
  'CityState',
  'HomeState',
  'SpaceState',
  'SpeakerState',
  'VideoCallState',
];

interface Violation {
  file: string;
  line: number;
  className: string;
  snippet: string;
}

function* walkFiles(dir: string): Generator<string> {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      yield* walkFiles(fullPath);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      yield fullPath;
    }
  }
}

function scanFileForSchemaClasses(filePath: string): Violation[] {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip comments
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    for (const className of SCHEMA_CLASSES) {
      // Look for class definitions: "export class PlayerState extends Schema"
      const classDefRegex = new RegExp(`class\\s+${className}\\s+extends\\s+Schema`);
      if (classDefRegex.test(line)) {
        violations.push({
          file: filePath,
          line: i + 1,
          className,
          snippet: line.trim(),
        });
      }
    }
  }

  return violations;
}

function main(): void {
  console.log('🔍 Scanning for duplicate schema classes...\n');

  const violations: Violation[] = [];

  for (const scanDir of SCAN_DIRS) {
    for (const file of walkFiles(scanDir)) {
      const fileViolations = scanFileForSchemaClasses(file);
      violations.push(...fileViolations);
    }
  }

  if (violations.length === 0) {
    console.log('✅ No schema duplicates found. All schemas in contract/realtime/.\n');
    process.exit(0);
  }

  console.error('❌ Found schema class definitions outside contract/realtime/:\n');
  for (const v of violations) {
    const relPath = v.file.replace(REPO_ROOT + '/', '');
    console.error(`  ${relPath}:${v.line}`);
    console.error(`    ${v.className} extends Schema`);
    console.error(`    ${v.snippet}\n`);
  }

  console.error(`\n❌ ${violations.length} violation(s) found.`);
  console.error('All @colyseus/schema classes must be defined in contract/realtime/states.ts');
  console.error('and imported from there. Delete duplicates and import from contract/realtime/.\n');
  process.exit(1);
}

main();
