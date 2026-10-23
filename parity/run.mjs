// Compares node-pandas against real pandas. Needs a Python with pandas + scipy:
//   PANDAS_PYTHON=/path/to/venv/bin/python npm run parity
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const python = process.env.PANDAS_PYTHON ?? 'python3';
const dir = mkdtempSync(join(tmpdir(), 'node-pandas-parity-'));
const suites = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(here).filter((f) => f.endsWith('.py') && readdirSync(here).includes(f.replace(/\.py$/, '.ts'))).map((f) => f.slice(0, -3)).sort();
let failed = false;
for (const suite of suites) {
  const ref = join(dir, `${suite}.json`);
  writeFileSync(ref, execFileSync(python, ['-I', join(here, `${suite}.py`)], { stdio: ['ignore', 'pipe', 'inherit'] }));
  console.log(`\n== ${suite}`);
  try {
    const out = execFileSync(process.execPath, [join(here, `${suite}.ts`), ref], { encoding: 'utf8' });
    process.stdout.write(out);
    if (!out.includes('ALL MATCH')) failed = true;
  } catch (e) {
    failed = true;
    process.stdout.write(String(e.stdout ?? e));
  }
}
process.exitCode = failed ? 1 : 0;
