// Runs every numbered example in order and reports which ones failed.
//   npm start            run all
//   npm start -- 09 12   run only the examples whose names start with these prefixes
//   npm start -- --quiet print only the summary
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const only = args.filter((a) => !a.startsWith('--'));
const files = readdirSync(here)
  .filter((f) => /^\d{2}-.+\.ts$/.test(f))
  .filter((f) => only.length === 0 || only.some((p) => f.startsWith(p)))
  .sort();

const failed = [];
for (const file of files) {
  const started = Date.now();
  const run = spawnSync(process.execPath, ['--no-warnings', join(here, file)], { cwd: here, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  const ms = Date.now() - started;
  if (!quiet) {
    console.log(`\n${'#'.repeat(70)}\n# ${file}\n${'#'.repeat(70)}`);
    process.stdout.write(run.stdout);
  }
  if (run.status !== 0) {
    failed.push(file);
    console.error(`\n✖ ${file} failed:\n${run.stderr}`);
  } else if (quiet) {
    console.log(`✓ ${file} (${ms} ms)`);
  }
}

console.log(`\n${files.length - failed.length}/${files.length} examples passed.`);
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}
