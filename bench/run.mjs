// Benchmarks pandasx against Arquero, danfo.js and Data-Forge.
//   npm run bench                                  # 100k and 1M rows
//   npm run bench -- --rows 10000,100000 --runs 3
//   npm run bench -- --tools pandasx,arquero
// Writes results.json and results.md next to this file.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, writeCsv } from './data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const sizes = arg('rows', '100000,1000000').split(',').map(Number);
const runs = arg('runs', '5');

const version = (pkg) => JSON.parse(readFileSync(join(here, 'node_modules', pkg, 'package.json'), 'utf8')).version;

const allTools = {
  pandasx: { label: 'pandasx', version: JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version, cmd: [process.execPath, ['--expose-gc', '--no-warnings', join(here, 'adapters/pandasx.mjs')]] },
  arquero: { label: 'Arquero', version: version('arquero'), cmd: [process.execPath, ['--expose-gc', join(here, 'adapters/arquero.mjs')]] },
  danfojs: { label: 'danfo.js', version: version('danfojs'), cmd: [process.execPath, ['--expose-gc', '--no-warnings', join(here, 'adapters/danfojs.mjs')]] },
  'data-forge': { label: 'Data-Forge', version: version('data-forge'), cmd: [process.execPath, ['--expose-gc', join(here, 'adapters/data-forge.mjs')]] },
};
const wanted = arg('tools', Object.keys(allTools).join(',')).split(',');
const tools = Object.fromEntries(wanted.filter((t) => allTools[t]).map((t) => [t, allTools[t]]));

const dir = mkdtempSync(join(tmpdir(), 'pandasx-bench-'));
const results = {
  date: new Date().toISOString().slice(0, 10),
  machine: { cpu: cpus()[0].model, cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), node: process.version, platform: `${process.platform}-${process.arch}` },
  tools: Object.fromEntries(Object.entries(tools).map(([k, t]) => [k, { label: t.label, version: t.version }])),
  sizes: {},
};

try {
  for (const rows of sizes) {
    const csv = join(dir, `data-${rows}.csv`);
    writeCsv(csv, generate(rows));
    results.sizes[rows] = {};
    for (const [name, tool] of Object.entries(tools)) {
      console.log(`\n${tool.label} — ${rows.toLocaleString('en-US')} rows`);
      const [bin, args] = tool.cmd;
      const out = execFileSync(bin, [...args, csv, String(rows), runs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 24 });
      results.sizes[rows][name] = JSON.parse(out);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// Every tool must agree on what it computed.
const mismatches = [];
for (const [rows, byTool] of Object.entries(results.sizes)) {
  const [first, ...rest] = Object.entries(byTool);
  for (const task of Object.keys(first[1])) {
    for (const [name, r] of rest) {
      if (r[task] && r[task].check !== first[1][task].check) mismatches.push(`${rows} rows, ${task}: ${first[0]}=${first[1][task].check} ${name}=${r[task].check}`);
    }
  }
}

const fmt = (ms) => (ms < 0.05 ? '<0.1 ms' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 10 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(1)} ms`);
const md = [];
for (const [rows, byTool] of Object.entries(results.sizes)) {
  const names = Object.keys(byTool);
  md.push(`### ${Number(rows).toLocaleString('en-US')} rows`, '');
  md.push(`| Task | ${names.map((n) => results.tools[n].label).join(' | ')} |`);
  md.push(`|---|${names.map(() => '---:').join('|')}|`);
  for (const task of Object.keys(byTool[names[0]])) {
    const times = names.map((n) => byTool[n][task]?.ms);
    const best = Math.min(...times.filter((t) => t !== undefined));
    md.push(`| \`${task}\` | ${times.map((t) => (t === undefined ? '—' : t === best ? `**${fmt(t)}**` : fmt(t))).join(' | ')} |`);
  }
  md.push('');
}
const table = md.join('\n');

writeFileSync(join(here, 'results.json'), JSON.stringify(results, null, 2) + '\n');
writeFileSync(join(here, 'results.md'), table);
console.log(`\n${table}`);
if (mismatches.length) {
  console.error(`\nResults differ between tools:\n  ${mismatches.join('\n  ')}`);
  process.exitCode = 1;
}
