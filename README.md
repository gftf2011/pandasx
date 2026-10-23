# node-pandas

`Series` e `DataFrame` no estilo do [pandas](https://pandas.pydata.org/) para Node.js, escritos em TypeScript.

- Armazenamento **colunar e tipado**: números e datas em `Float64Array`, booleanos em `Uint8Array` e categorias em `Int32Array`.
- API **fiel ao pandas**, com nomes em camelCase (`sort_values` → `sortValues`, `read_csv` → `readCsv`).
- **Verificado contra o pandas real**: 214 casos de paridade (`npm run parity`) mais fixtures gravados pelo pandas 3.1.
- **Sem dependências obrigatórias.** Excel, Parquet, Feather e HDF5 usam pacotes opcionais, instalados só por quem precisa.

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
  .query('quantidade > 0')
  .assign({ receita: (d) => d.get('quantidade').mul(d.get('preco')) })
  .groupby('regiao')
  .agg({ receita: 'sum', quantidade: ['mean', 'max'] })
  .sortValues(['receita', 'sum']);

console.log(resumo);
//         receita  quantidade
//             sum        mean  max
// regiao
// MG         83.3         7.0    7
// RJ        142.0         8.0   12
// SP        437.5        17.5   25
```

## Do pandas para o node-pandas

O Python tem sobrecarga de `[]` e de operadores. O JavaScript não tem, então essas formas viram métodos:

| pandas (Python) | node-pandas |
|---|---|
| `df['a']`, `df[['a','b']]`, `df[mask]` | `df.get('a')`, `df.get(['a','b'])`, `df.get(mask)` |
| `df['c'] = v` | `df.set('c', v)` |
| `df.loc['x', 'a']`, `df.loc['x':'z']` | `df.loc('x', 'a')`, `df.loc(pd.slice('x', 'z'))` |
| `df.loc[mask, 'a'] = 0` | `df.setLoc(mask, 'a', 0)` (também `setIloc`, `setAt`, `setIat`) |
| `s + 1`, `s == 1`, `(a > 1) & ~b` | `s.add(1)`, `s.eq(1)`, `a.gt(1).and(b.not())` |
| `df.query('a > 1 and b == "x"')` | `df.query('a > 1 and b == "x"')` (a mesma sintaxe) |
| `df.groupby('k')['v'].sum()` | `df.groupby('k').get('v').sum()` |
| `df[('preco', 'min')]` (colunas MultiIndex) | `df.column(['preco', 'min'])` |
| `pd.option_context('display.precision', 2)` | `pd.optionContext({ 'display.precision': 2 }, () => ...)` |
| `df.plot.bar()` (matplotlib) | `df.plot.bar()` → SVG |

## O que existe

**Tipos**: `int64`, `float64`, `bool`, os anuláveis `Int64`, `Float64` e `boolean` (lógica de Kleene), `string`, `category` (com o acessor `.cat`), `datetime` com fuso horário, `timedelta`, `period`, `bigint` (inteiros exatos acima de 2^53) e `object`. Há também `convertDtypes`.

**Seleção e atribuição**: `get`, `loc`, `iloc`, `at`, `iat`, `xs` e os respectivos `set*`, com crescimento por rótulo novo; `query` e `eval` com expressões em string (`and`/`or`/`not`, `in`, comparações encadeadas, `@variáveis`, nomes entre crases, `nome.str.startswith(...)`).

**Estatística**: as agregações usuais e mais `sem`, `skew`, `kurt`, `quantile` (todas as interpolações), `rank` (5 métodos), `corr` (Pearson, Spearman e Kendall), `cov`, `corrwith`, `autocorr`, `describe`, `valueCounts`, `mode` e as operações acumuladas.

**Dados ausentes**: `isna`, `fillna`, `dropna`, `ffill`, `bfill` e `interpolate` (linear, time, index, nearest, zero, quadratic, cubic, spline, polynomial, pchip e akima, com `limit`, `limitDirection` e `limitArea`).

**Strings**: o acessor `.str` completo, incluindo `split` e `extract` com `expand`, `extractall`, `findall`, `getDummies`, `wrap`, `translate` e `normalize`.

**Séries temporais**: `rolling` (por número de linhas ou por tempo, com `center`, `closed` e `winType`), `expanding`, `ewm`, `resample` (calendário e frequência fixa, `closed`, `label`, `origin`, `ohlc` e upsampling), `asfreq`, `shift` com `freq` e offsets (`B`, `W-MON`, `ME`, `MS`, `QE`, `YS`, `BME`, `SME`, `DateOffset`). Também há `dateRange`, `bdateRange`, `periodRange`, `timedeltaRange`, `toDatetime` (com `format`, `errors`, `utc`, `dayfirst` e `unit`), `toTimedelta`, fusos IANA (`tzLocalize`/`tzConvert`, com tratamento de horário de verão), o acessor `.dt` completo, `atTime`, `betweenTime` e `truncate`.

**GroupBy**: agrupa por coluna, Series, array, função ou nível do índice; tem `agg` (por lista, dict ou agregação nomeada), `transform`, `filter`, `apply`, `shift`, `diff`, `rank`, `cumsum`, `nth`, `quantile`, `describe`, `ohlc`, e `rolling`/`expanding`/`ewm`/`resample` por grupo.

**MultiIndex e reshape**: MultiIndex nas linhas e nas colunas (`fromTuples`, `fromProduct`, `droplevel`, `swaplevel`, `xs`, `loc` parcial), `stack`, `unstack`, `pivot`, `pivotTable` (com `margins`), `crosstab`, `melt`, `wideToLong`, `explode`, `getDummies`/`fromDummies`, `cut`/`qcut` (com `Interval`), `factorize`, `merge` (inclusive por índice), `mergeAsof`, `mergeOrdered`, `join`, `concat`, `combineFirst`, `update` e `compare`.

**Entrada e saída**:

| Formato | Leitura | Escrita | Depende de |
|---|---|---|---|
| CSV, TSV, largura fixa | `readCsv`, `readCsvAsync`, `readCsvChunks` (streaming), `readTable`, `readFwf` | `toCsv` | nada |
| JSON e JSON Lines | `readJson`, `readJsonAsync` | `toJson` | nada |
| HTML | `readHtml` | `toHtml`, `df.style.toHtml()` | nada |
| XML | `readXml` | `toXml` | nada |
| SQL | `readSql`, `readSqlQuery`, `readSqlTable`, `readSqlChunks` | `toSql` | `node:sqlite` (nativo), better-sqlite3, pg ou mysql2 |
| Excel `.xlsx` | `readExcel` | `toExcel`, `ExcelWriter` | `exceljs` |
| Parquet | `readParquet` | `toParquet` | `hyparquet`, `hyparquet-writer` |
| Feather / Arrow | `readFeather`, `fromArrow` | `toFeather`, `toArrow` | `apache-arrow` |
| HDF5 | `readHdf` (formatos fixed e table) | `toHdf` (formato table) | `h5wasm` |
| LaTeX, Markdown | | `toLatex`, `toMarkdown` | nada |

A compressão (gzip, zstd, brotli, deflate e zip) é detectada pela extensão ou pelos bytes iniciais. URLs são lidas pelas variantes `*Async`.

**Exibição**: `console.log` imprime como o pandas, inclusive escondendo colunas para caber em `display.width`. Há `setOption`, `getOption`, `resetOption` e `optionContext`, além de `info()` e `memoryUsage()`.

**Gráficos** (`df.plot`, retornam SVG): line, bar, barh, hist, box, kde, area, pie, scatter, hexbin e `subplots`. Os gráficos usam uma paleta validada para daltonismo, com tema claro e escuro automáticos, tooltip nativo em cada marca e rótulos diretos. Com `path: 'x.html'`, a saída é uma página com o gráfico e a tabela de dados.

**Styler** (`df.style`): `highlightMax`, `highlightMin`, `highlightNull`, `highlightBetween`, `highlightQuantile`, `backgroundGradient`, `textGradient`, `bar`, `format` (com a mini-linguagem do Python, por exemplo `'R$ {:,.2f}'`), `map`, `apply`, `hide`, `setCaption`, `setTableStyles`, `toHtml`, `toLatex` e `toExcel` com cores.

## Diferenças em relação ao pandas

- **Rótulos de coluna únicos e em string.** Uma coluna MultiIndex é uma tupla de strings: `df.columnIndex` mostra as tuplas, e em `df.columns` as partes vêm unidas pelo caractere `\u001f`. Para nomes achatados como `preco_min`, use `flattenColumns()`.
- **Sem eixo Y secundário nos gráficos.** É uma escolha de design: dois eixos com escalas diferentes enganam a leitura. Use `subplots`.
- **Mais de 8 séries num gráfico gera erro**, em vez de repetir cores. Selecione colunas ou use `subplots`. Na pizza, o excesso vira "Other".
- **`rolling(..., { winType }).std()/.var()`** usa os pesos acompanhando a janela. O pandas atribui os pesos por posição absoluta, o que é inconsistente com o próprio `mean` ponderado dele.
- **I/O assíncrono**: Excel, Parquet, Feather, HDF5 e SQL retornam `Promise`, porque as bibliotecas que eles usam são assíncronas.
- **HDF5**: a escrita usa só o formato `table`, ainda sem MultiIndex nas linhas. Categorias gravadas em Parquet são lidas pelo pandas como string.
- Booleanos aparecem como `true`/`false` no `console.log`. Nas exportações (HTML, XML e CSV) aparecem como `True`/`False`, como no pandas.

## Desenvolvimento

```bash
npm test
```

```bash
npm run typecheck
```

```bash
PANDAS_PYTHON=/caminho/para/venv/bin/python npm run parity
```

A paridade compara cada caso com o pandas real; ela precisa de um Python com pandas, scipy, pyarrow, tables, openpyxl e lxml. O script `parity/fixtures.py` regera os arquivos de `test/fixtures`.

## Licença

MIT
