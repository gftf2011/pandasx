// danfo.js (the pure-JS "danfojs" package; "danfojs-node" only adds native
// TensorFlow bindings, which these operations do not use). In Node the
// package's readCSV only fetches URLs, so read_csv does what it does
// internally: Papa.parse with the same options, then new DataFrame(rows).
import { readFileSync } from 'node:fs';
import * as dfd from 'danfojs';
import Papa from 'papaparse';
import { run } from '../harness.mjs';

let df, right;

await run({
  setup(ctx) {
    df = new dfd.DataFrame(ctx.cols);
    right = new dfd.DataFrame(ctx.lookupCols);
  },
  tasks: {
    read_csv: (ctx) => {
      const { data } = Papa.parse(readFileSync(ctx.csvPath, 'utf8'), { header: true, dynamicTyping: true, skipEmptyLines: 'greedy', delimiter: ',' });
      return new dfd.DataFrame(data).shape[0];
    },
    construct: (ctx) => new dfd.DataFrame(ctx.cols).shape[0],
    filter: () => df.query(df['x'].gt(0.5).and(df['cat'].eq('c3'))).shape[0],
    sort: () => df.sortValues('x').column('id').iat(0),
    groupby: () => df.groupby(['key']).agg({ x: 'sum', y: 'mean' }).shape[0],
    merge: () => dfd.merge({ left: df, right, on: ['key'], how: 'inner' }).shape[0],
    arithmetic: () => df.addColumn('z', df['x'].mul(df['y']).add(df['n']), { inplace: false }).shape[0],
    stats: () => {
      const x = df['x'];
      x.std();
      return Math.round(x.mean() * 1e6) / 1e6;
    },
    value_counts: () => df['cat'].valueCounts().shape[0],
    to_csv: () => dfd.toCSV(df).length > 0,
  },
});
