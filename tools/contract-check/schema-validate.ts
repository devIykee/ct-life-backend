/**
 * Schema validator for the contract.
 *
 * Reads every JSON file in contract/ids/ and contract/config/, validates
 * it against its companion `*.schema.json`, and fails with a clear
 * message if anything is invalid. Also checks that every IDs file has
 * an `ids.schema.json`-compliant envelope (owner, provisional, version)
 * and that every config file is JSON-parseable.
 *
 * Run: tsx tools/contract-check/schema-validate.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';

const REPO = process.cwd();
const ID_DIR = join(REPO, 'contract/ids');
const CONFIG_DIR = join(REPO, 'contract/config');

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'ids.schema.json') continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (extname(p) === '.json') out.push(p);
  }
  return out;
}

function readJson(p: string): unknown {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function main(): void {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  let failed = 0;

  // ID files: validate against ids.schema.json envelope.
  const idSchema = ajv.compile(
    readJson(join(ID_DIR, 'ids.schema.json')) as Parameters<typeof ajv.compile>[0],
  );
  for (const file of walk(ID_DIR)) {
    const data = readJson(file);
    if (!idSchema(data)) {
      // eslint-disable-next-line no-console
      console.log(`[FAIL] ${file.replace(`${REPO}/`, '')}: ids envelope invalid`);
      for (const err of idSchema.errors ?? [])
        // eslint-disable-next-line no-console
        console.log(`    - ${err.message}`);
      failed++;
    }
  }

  // Config files: validate against the companion *.schema.json.
  for (const file of walk(CONFIG_DIR)) {
    if (file.endsWith('.schema.json')) continue;
    const schemaPath = file.replace(/\.json$/, '.schema.json');
    let schemaData: unknown;
    try {
      schemaData = readJson(schemaPath);
    } catch {
      // eslint-disable-next-line no-console
      console.log(`[FAIL] ${file.replace(`${REPO}/`, '')}: missing schema ${schemaPath}`);
      failed++;
      continue;
    }
    const validate = ajv.compile(schemaData as Parameters<typeof ajv.compile>[0]);
    const data = readJson(file);
    if (!validate(data)) {
      // eslint-disable-next-line no-console
      console.log(`[FAIL] ${file.replace(`${REPO}/`, '')}: failed validation`);
      for (const err of validate.errors ?? [])
        // eslint-disable-next-line no-console
        console.log(`    - ${err.instancePath || '<root>'}: ${err.message}`);
      failed++;
    }
  }

  if (failed === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `schema-validate: OK (${walk(ID_DIR).length} ids, ${walk(CONFIG_DIR).filter((f) => !f.endsWith('.schema.json')).length} config).`,
    );
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.log(`schema-validate: ${failed} failure(s).`);
  process.exit(1);
}

main();
