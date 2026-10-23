// Runs every ```ts run``` block in the guides and writes its console output into
// the ```text``` block right after it, so the documented output is always real.
//
//   node scripts/run-examples.mjs           update outputs
//   node scripts/run-examples.mjs --check   fail if any output is stale
// Examples run in docs/.cache/examples; SVG / HTML files they write are copied to public/plots.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(docs, '..', 'src', 'index.ts');
const cache = join(docs, '.cache', 'examples');
const check = process.argv.includes('--check');

const BLOCK = /```ts run\n([\s\S]*?)```\n(?:\n?```text\n[\s\S]*?```\n)?/g;

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' || f === 'api' || f.startsWith('.') ? [] : markdownFiles(p);
    return f.endsWith('.md') ? [p] : [];
  });
}

rmSync(cache, { recursive: true, force: true });
mkdirSync(cache, { recursive: true });
let stale = 0, total = 0;

for (const file of markdownFiles(docs)) {
  const src = readFileSync(file, 'utf8');
  let n = 0;
  const out = src.replace(BLOCK, (_, code) => {
    n++; total++;
    const script = join(cache, `${relative(docs, file).replace(/[\\/]/g, '_')}-${n}.ts`);
    const importPath = relative(cache, entry).replace(/\\/g, '/');
    writeFileSync(script, code.replace(/from 'pandasx'/g, `from '${importPath.startsWith('.') ? importPath : './' + importPath}'`));
    let output;
    try {
      output = execFileSync(process.execPath, ['--no-warnings', script], { encoding: 'utf8', cwd: cache, env: { ...process.env, TZ: 'UTC', FORCE_COLOR: '0' } });
    } catch (e) {
      console.error(`\n✖ ${relative(docs, file)} example #${n} failed:\n${e.stderr || e.message}`);
      process.exit(1);
    }
    output = output.replace(/\s+$/, '');
    return '```ts run\n' + code + '```\n' + (output ? '\n```text\n' + output + '\n```\n' : '');
  });
  if (out !== src) {
    if (check) { stale++; console.error(`✖ outdated example output in ${relative(docs, file)}`); }
    else writeFileSync(file, out);
  }
}

// Charts and pages written by examples (path: 'x.svg' / 'x.html') are published under /plots/.
const plots = join(docs, 'public', 'plots');
mkdirSync(plots, { recursive: true });
for (const f of readdirSync(cache)) if (/\.(svg|html)$/.test(f)) copyFileSync(join(cache, f), join(plots, f));

if (check && stale) {
  console.error(`\n${stale} file(s) have outdated outputs: run "npm run examples" in docs/ and commit.`);
  process.exit(1);
}
console.log(`${total} examples ${check ? 'verified' : 'executed'}.`);
