// pandasx, imported from the repository source (src/), not from npm.
import * as pd from '../../src/index.ts';
import { run } from '../harness.mjs';

let df, right;

await run({
  setup(ctx) {
    df = new pd.DataFrame(ctx.cols);
    right = new pd.DataFrame(ctx.lookupCols);
  },
  tasks: {
    read_csv: (ctx) => pd.readCsv(ctx.csvPath).length,
    construct: (ctx) => new pd.DataFrame(ctx.cols).length,
    filter: () => df.get(df.get('x').gt(0.5).and(df.get('cat').eq('c3'))).length,
    sort: () => df.sortValues('x').get('id').iat(0),
    groupby: () => df.groupby('key').agg({ x: 'sum', y: 'mean' }).length,
    merge: () => pd.merge(df, right, { on: 'key' }).length,
    arithmetic: () => df.assign({ z: (d) => d.get('x').mul(d.get('y')).add(d.get('n')) }).length,
    stats: () => {
      const x = df.get('x');
      x.std();
      return Math.round(x.mean() * 1e6) / 1e6;
    },
    value_counts: () => df.get('cat').valueCounts().length,
    to_csv: () => df.toCsv().length > 0,
  },
});
