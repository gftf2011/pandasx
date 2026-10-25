// Data-Forge. It is lazy and row-oriented, so every task ends with bake() (or a
// reduction) to force the work to happen inside the timed region.
import { readFileSync } from 'node:fs';
import * as dataForge from 'data-forge';
import { run } from '../harness.mjs';

let df, right;

await run({
  setup(ctx) {
    df = new dataForge.DataFrame({ columns: ctx.cols }).bake();
    right = new dataForge.DataFrame({ columns: ctx.lookupCols }).bake();
  },
  tasks: {
    read_csv: (ctx) => dataForge.fromCSV(readFileSync(ctx.csvPath, 'utf8'), { dynamicTyping: true }).bake().count(),
    construct: (ctx) => new dataForge.DataFrame({ columns: ctx.cols }).bake().count(),
    filter: () => df.where((r) => r.x > 0.5 && r.cat === 'c3').bake().count(),
    sort: () => df.orderBy((r) => r.x).bake().first().id,
    groupby: () =>
      df
        .groupBy((r) => r.key)
        .select((g) => ({ key: g.first().key, x: g.deflate((r) => r.x).sum(), y: g.deflate((r) => r.y).average() }))
        .inflate()
        .bake()
        .count(),
    merge: () =>
      df
        .join(right, (l) => l.key, (r) => r.key, (l, r) => ({ ...l, weight: r.weight }))
        .bake()
        .count(),
    arithmetic: () => df.generateSeries({ z: (r) => r.x * r.y + r.n }).bake().count(),
    stats: () => {
      const x = df.getSeries('x');
      x.std();
      return Math.round(x.average() * 1e6) / 1e6;
    },
    value_counts: () =>
      df
        .getSeries('cat')
        .groupBy((v) => v)
        .select((g) => ({ cat: g.first(), count: g.count() }))
        .inflate()
        .bake()
        .count(),
    to_csv: () => df.toCSV().length > 0,
  },
});
