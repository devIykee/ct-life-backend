/**
 * Renderer for the OpenAPI HTML docs.
 *
 * The amendment requires `openapi.yaml` to be rendered to static HTML and
 * served at `/docs` in non-production. This script generates the HTML
 * using `@redocly/cli` and writes it to `contract/openapi/generated/index.html`.
 *
 * In CI, a separate job runs this and serves the result at `/docs` from
 * the `mock` environment. Locally, you can `python3 -m http.server` from
 * `contract/openapi/generated/`.
 *
 * Run: pnpm contract:docs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const SRC = join(REPO, 'contract/openapi.yaml');
const OUT = join(REPO, 'contract/openapi/generated');

function main(): void {
  if (!existsSync(SRC)) {
    // eslint-disable-next-line no-console
    console.log(`openapi-docs: ${SRC} not found.`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });

  // Try @redocly/cli first (preferred). If absent, fall back to a
  // built-in HTML wrapper that embeds the YAML source.
  const result = spawnSync(
    'npx',
    ['--yes', '@redocly/cli', 'build-docs', SRC, '--output', join(OUT, 'index.html')],
    { stdio: 'inherit' },
  );
  if (result.status === 0) {
    // eslint-disable-next-line no-console
    console.log(`openapi-docs: wrote ${join(OUT, 'index.html')}`);
    process.exit(0);
  }

  // Fallback: produce a minimal HTML wrapper that loads the YAML
  // and renders it client-side via the redoc standalone CDN.
  const yaml = readFileSync(SRC, 'utf8');
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>CT Life REST API</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
    <style>body { margin: 0; padding: 0; }</style>
  </head>
  <body>
    <redoc spec-url="openapi.yaml"></redoc>
    <script src="https://cdn.redocly.com/redoc/latest/bundles/redoc.standalone.js"></script>
  </body>
</html>
`;
  writeFileSync(join(OUT, 'index.html'), html, 'utf8');
  writeFileSync(join(OUT, 'openapi.yaml'), yaml, 'utf8');
  // eslint-disable-next-line no-console
  console.log(
    `openapi-docs: redocly unavailable, wrote a CDN-based fallback to ${join(OUT, 'index.html')}.`,
  );
  process.exit(0);
}

main();
