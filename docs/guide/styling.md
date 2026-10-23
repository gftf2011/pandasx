# Styling tables

`df.style` returns a `Styler`, the equivalent of pandas' `DataFrame.style`: it formats values and attaches CSS to cells, then renders HTML (or LaTeX). The data itself is not changed.

```ts run
import * as pd from 'pandasx';
import { writeFileSync } from 'node:fs';

const df = new pd.DataFrame(
  { revenue: [12500.5, 9800, 15320.25, null], growth: [0.12, -0.035, 0.27, 0.08] },
  { index: ['North', 'South', 'East', 'West'] },
);

const html = df.style
  .format({ revenue: '${:,.2f}', growth: '{:+.1%}' }, { naRep: '—' })
  .highlightMax({ subset: 'revenue', color: '#d6f5e6' })
  .highlightNull({ color: '#fde2e1' })
  .bar({ subset: 'growth', align: 'zero', color: ['#f4a3a0', '#9ec5f4'] })
  .setCaption('Revenue by region')
  .setUuid('demo')
  .setTableStyles([
    { selector: '', props: 'border-collapse: collapse; font: 14px system-ui, sans-serif' },
    { selector: 'th', props: 'padding: 6px 12px; border-bottom: 1px solid #e1e0d9' },
    { selector: 'td', props: 'padding: 6px 12px; border-bottom: 1px solid #e1e0d9' },
    { selector: 'caption', props: 'font-weight: 600; padding-bottom: 8px; text-align: left' },
  ])
  .toHtml({ doctype: true });

writeFileSync('styled.html', html);
console.log(df.style.format({ revenue: '${:,.2f}', growth: '{:+.1%}' }, { naRep: '—' }).toString());
```

```text
 revenue growth
North $12,500.50 +12.0%
South $9,800.00 -3.5%
East $15,320.25 +27.0%
West — +8.0%
```

The rendered table:

<iframe src="/pandasx/plots/styled.html" title="Styled table" style="width:100%;height:240px;border:1px solid var(--vp-c-divider);border-radius:8px;background:#fff"></iframe>

Format strings use Python's format-spec mini-language (`{:,.2f}`, `{:.1%}`, `{:>8}`, `{:e}`…), so formats copied from pandas code work unchanged. `pd.pyFormat('{:,.2f}', 1234.5)` exposes the same formatter.

## Built-in styles

| Method | Effect |
|---|---|
| `highlightMax` / `highlightMin` | Background on the extreme per column (`axis: 0`), row (`axis: 1`) or table (`axis: null`) |
| `highlightNull` | Missing values |
| `highlightBetween({ left, right, inclusive })` | Values in a range |
| `highlightQuantile({ qLeft, qRight })` | Values in a quantile band |
| `backgroundGradient({ cmap, low, high, vmin, vmax })` | Cell background from a colour map (`Blues`, `Oranges`, `Greens`, `Reds`, `Purples`, `Greys`, `RdBu`, `coolwarm`); text switches to light on dark cells |
| `textGradient({ cmap })` | Text colour from a colour map |
| `bar({ align, color, width, vmin, vmax })` | In-cell data bars; `align: 'zero'` / `'mid'` for signed values |

`subset` restricts any style to columns (`'a'`, `['a', 'b']`) or to `{ rows, columns }`.

## Custom styles

```ts run
import * as pd from 'pandasx';

const df = new pd.DataFrame({ a: [1, -2, 3], b: [-4, 5, -6] });
const styler = df.style
  .map((v) => ((v as number) < 0 ? 'color: #c0392b' : null))                     // element-wise
  .apply((col: pd.Series) => col.toArray().map((v) => ((v as number) === col.max() ? 'font-weight: bold' : '')), { axis: 0 })  // per column
  .setProperties({ 'text-align': 'right' })
  .setTableStyles([{ selector: 'th', props: 'background: #f5f5f4' }])
  .hide({ axis: 'index' });

console.log(styler.cellStyle(1, 0), styler.cellStyle(2, 0));
```

```text
[ 'color: #c0392b', 'text-align: right' ] [ 'font-weight: bold', 'text-align: right' ]
```

Also: `formatIndex`, `setTableAttributes`, `setUuid`, `setNaRep`, `setPrecision`, `toString()` (plain text) and `toLatex()`.

## Output

- `styler.toHtml()` — a `<style>` block plus the table (`{ doctype: true }` for a full page, `{ excludeStyles: true }` for the bare table).
- `styler.toLatex({ hrules: true, caption })` — a `tabular`, with `\cellcolor` / `\textbf` from the CSS where LaTeX supports it.
- `df.toHtml()` — the plain pandas-style table without styles.
