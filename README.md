# node-pandas

`Series` e `DataFrame` no estilo do [pandas](https://pandas.pydata.org/) para Node.js, escritos em TypeScript e sem dependências de runtime.

- Armazenamento **colunar e tipado**: colunas numéricas e datas ficam em `Float64Array`, booleanos em `Uint8Array`.
- API **fiel ao pandas**, com nomes em camelCase (`sort_values` → `sortValues`, `read_csv` → `readCsv`).
- Semântica de **valores ausentes** igual à do pandas: `NaN` nos números, `null` nos textos, NA ignorado nas agregações por padrão.
- **Alinhamento por índice** nas operações entre Series e DataFrames.

```bash
npm install node-pandas
```

Requer Node.js ≥ 22.18.

## Exemplo

```ts
import * as pd from 'node-pandas';

const df = new pd.DataFrame({
  regiao: ['SP', 'RJ', 'SP', 'MG', 'RJ', 'SP'],
  produto: ['café', 'café', 'chá', 'café', 'chá', 'café'],
  quantidade: [10, 4, 0, 7, 12, 25],
  preco: [12.5, 13, 8, 11.9, 7.5, 12.5],
});
// ou: const df = pd.readCsv('vendas.csv', { parseDates: ['data'] });

const resumo = df
  .loc(df.get('quantidade').gt(0))
  .assign({ receita: (d) => d.get('quantidade').mul(d.get('preco')) })
  .groupby('regiao')
  .agg({ receita: 'sum', quantidade: ['mean', 'max'] })
  .sortValues('receita', { ascending: false });

console.log(resumo);
//         receita  quantidade_mean  quantidade_max
// regiao
// SP        437.5             17.5              25
// RJ        142.0              8.0              12
// MG         83.3              7.0               7
```

`console.log` imprime a tabela formatada como no pandas (com truncamento para tabelas grandes).

## Do pandas para o node-pandas

O Python tem sobrecarga de operadores e de `[]`. O JavaScript não tem, então essas formas viram métodos:

| pandas (Python) | node-pandas |
|---|---|
| `df['a']` | `df.get('a')` |
| `df[['a', 'b']]` | `df.get(['a', 'b'])` |
| `df[df.a > 1]` | `df.loc(df.get('a').gt(1))` |
| `df['c'] = valores` | `df.set('c', valores)` |
| `df.loc['x', 'a']` | `df.loc('x', 'a')` |
| `df.loc['x':'z']` | `df.loc(pd.slice('x', 'z'))` (fim inclusivo) |
| `df.iloc[1:3, 0]` | `df.iloc(pd.slice(1, 3), 0)` |
| `df.loc[:, 'a':'c']` | `df.loc(null, pd.slice('a', 'c'))` |
| `s + 1`, `s * t`, `s / t` | `s.add(1)`, `s.mul(t)`, `s.div(t)` |
| `s == 1`, `s >= t` | `s.eq(1)`, `s.ge(t)` |
| `(a > 1) & (b < 2)`, `~m` | `a.gt(1).and(b.lt(2))`, `m.not()` |
| `df.query('a > 1')` | `df.query((row) => row.a > 1)` |
| `df.apply(f, axis=1)` | `df.apply((row) => ..., { axis: 1 })` (a linha chega como objeto JS) |
| `df.groupby('k')['v'].sum()` | `df.groupby('k').get('v').sum()` |
| `.agg(total=('v', 'sum'))` | `.agg({ total: ['v', 'sum'] })` |
| `pd.read_csv(..., index_col='id')` | `pd.readCsv(..., { indexCol: 'id' })` |
| `df.to_dict('records')` | `df.toRecords()` |

## O que já existe

**Series**: `loc`/`iloc`/`at`/`iat`/`get`, `head`/`tail`/`sample`, aritmética e comparações com alinhamento (`add`, `sub`, `mul`, `div`, `mod`, `pow`, `eq`, `gt`, ...), `and`/`or`/`not`, `sum`, `mean`, `median`, `std`, `var`, `min`, `max`, `count`, `quantile`, `describe`, `valueCounts`, `unique`, `nunique`, `mode`, `idxmax`, `cumsum`/`cumprod`/`cummax`/`cummin`, `shift`, `diff`, `pctChange`, `rank`, `map`, `apply`, `astype`, `replace`, `where`/`mask`, `isin`, `between`, `clip`, `round`, `abs`, `isna`/`fillna`/`dropna`/`ffill`/`bfill`/`interpolate`, `sortValues`/`sortIndex`, `nlargest`/`nsmallest`, `duplicated`/`dropDuplicates`, `reindex`, `groupby`.

**Acessores**: `s.str` (`lower`, `upper`, `strip`, `contains`, `startswith`, `replace`, `split`, `get`, `extract`, `len`, `pad`, `zfill`, ...) e `s.dt` (`year`, `month`, `day`, `hour`, `dayofweek`, `quarter`, `normalize`, `strftime`, ...).

**DataFrame**: criação a partir de colunas, de registros ou de linhas; `get`/`set`/`assign`/`insert`/`pop`/`drop`/`rename`, `loc`/`iloc`/`at`/`iat`, `query`, `filter`, `selectDtypes`, agregações por coluna ou por linha (`{ axis: 1 }`), `agg`, `describe`, `info`, `corr`/`cov`, `apply`/`map`, operações elemento a elemento, `fillna`/`dropna` (`how`, `thresh`, `subset`), `sortValues` com várias chaves, `setIndex`/`resetIndex`, `reindex`, `dropDuplicates`, `valueCounts`, `melt`, `pivotTable`, `transpose`/`T`, `join`, `merge`.

**GroupBy**: uma ou várias chaves (o índice fica com rótulos em tupla), `sort`/`dropna`/`asIndex`, `size`, `sum`/`mean`/.../`first`/`last`/`nunique`, `agg` (por coluna, lista ou nomeado), `apply`, `transform`, `filter`, `head`/`tail`, `cumcount`, `getGroup`, iteração com `for...of`.

**Combinação**: `merge` (`inner`, `left`, `right`, `outer`, `cross`, `leftOn`/`rightOn`, `suffixes`, `indicator`, `validate`) e `concat` (eixos 0 e 1, `join: 'inner' | 'outer'`, `ignoreIndex`).

**I/O**: `readCsv`/`parseCsv` (aspas RFC 4180, `sep`, `header`, `names`, `indexCol`, `usecols`, `dtype`, `naValues`, `parseDates`, `nrows`, `skiprows`, `thousands`), `toCsv`, `readJson`/`toJson` (orients `records`, `columns`, `index`, `split`, `values` e JSON lines).

**Datas**: `toDatetime`, `dateRange` (`ms`, `s`, `min`, `h`, `D`, `W`, `MS`).

## Tipos de dados

| dtype | armazenamento | valor ausente |
|---|---|---|
| `int64` | `Float64Array` (inteiros exatos até 2^53) | não aceita; vira `float64` |
| `float64` | `Float64Array` | `NaN` |
| `bool` | `Uint8Array` | não aceita; vira `object` |
| `datetime` | `Float64Array` (epoch em ms, UTC) | `NaN` (exibido como `NaT`) |
| `string` | `Array` | `null` |
| `object` | `Array` | `null` |

## Diferenças em relação ao pandas

- **MultiIndex**: um groupby com várias chaves gera um índice de tuplas (`['SP', 'a']`). `resetIndex()` separa as tuplas em colunas. `agg` com lista de funções gera colunas achatadas (`preco_min`, `preco_max`).
- **Agregações numéricas** (`sum`, `mean`, `std`, ...) no DataFrame e no GroupBy ignoram colunas não numéricas, como `numeric_only=True`.
- Os nomes de coluna são sempre strings.
- O fuso horário é sempre UTC.

## Desenvolvimento

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run build
```

Os testes rodam direto nos arquivos `.ts`, usando o type stripping nativo do Node e o `node:test`. O código fica em `src/`: `core/` tem a coluna tipada, o índice e os kernels de agregação, ordenação e formatação, e por cima vêm `series.ts`, `frame.ts`, `groupby.ts`, `reshape.ts` e `io/`.

## Licença

MIT
