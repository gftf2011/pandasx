// Runs an adapter's tasks and prints { task: { ms, check } } as JSON on stdout.
// A task returns a small value (row count, group count…) used to check that
// every tool computed the same thing.
// Each task gets one warm-up run, then the median of up to `runs` timed runs
// (fewer when a single run is slow, so the slowest tools still finish).
import { generate, lookup } from './data.mjs';

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export async function run(adapter) {
  const [csvPath, rowsArg, runsArg] = process.argv.slice(2);
  const rows = Number(rowsArg);
  const maxRuns = Number(runsArg ?? 5);
  const cols = generate(rows);
  const ctx = { csvPath, cols, lookupCols: lookup() };
  await adapter.setup?.(ctx);
  const out = {};
  for (const [name, task] of Object.entries(adapter.tasks)) {
    if (!task) continue;
    const times = [];
    let check;
    globalThis.gc?.();
    let t0 = performance.now();
    await task(ctx); // warm-up
    const warm = performance.now() - t0;
    const runs = warm > 10_000 ? 1 : warm > 2_000 ? 3 : maxRuns;
    for (let i = 0; i < runs; i++) {
      globalThis.gc?.();
      t0 = performance.now();
      const res = await task(ctx);
      times.push(performance.now() - t0);
      check = res;
    }
    out[name] = { ms: median(times), check };
    process.stderr.write(`  ${name.padEnd(12)} ${median(times).toFixed(1).padStart(10)} ms\n`);
  }
  process.stdout.write(JSON.stringify(out));
}
