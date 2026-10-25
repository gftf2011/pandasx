// Arquero. filter/orderby only set a mask or an order, so reify() materializes
// the result like the other tools do.
import { readFileSync } from 'node:fs';
import * as aq from 'arquero';
import { run } from '../harness.mjs';

const { op } = aq;
let dt, right;

await run({
  setup(ctx) {
    dt = aq.table(ctx.cols);
    right = aq.table(ctx.lookupCols);
  },
  tasks: {
    read_csv: (ctx) => aq.fromCSV(readFileSync(ctx.csvPath, 'utf8')).numRows(),
    construct: (ctx) => aq.table(ctx.cols).numRows(),
    filter: () => dt.filter((d) => d.x > 0.5 && d.cat === 'c3').reify().numRows(),
    sort: () => dt.orderby('x').reify().get('id', 0),
    groupby: () => dt.groupby('key').rollup({ x: (d) => op.sum(d.x), y: (d) => op.mean(d.y) }).numRows(),
    merge: () => dt.join(right, 'key').numRows(),
    arithmetic: () => dt.derive({ z: (d) => d.x * d.y + d.n }).numRows(),
    stats: () => {
      const r = dt.rollup({ m: (d) => op.mean(d.x), s: (d) => op.stdev(d.x) });
      return Math.round(r.get('m', 0) * 1e6) / 1e6;
    },
    value_counts: () => dt.groupby('cat').count().numRows(),
    to_csv: () => dt.toCSV().length > 0,
  },
});
