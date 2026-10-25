### 100,000 rows

| Task | pandasx | Arquero | danfo.js | Data-Forge |
|---|---:|---:|---:|---:|
| `read_csv` | 107 ms | **82 ms** | 212 ms | 247 ms |
| `construct` | 15 ms | **<0.1 ms** | 21 ms | 112 ms |
| `filter` | 9.1 ms | **7.7 ms** | 49 ms | 12 ms |
| `sort` | **20 ms** | 47 ms | 2.19 s | 181 ms |
| `groupby` | **18 ms** | 24 ms | 91 ms | 130 ms |
| `merge` | **19 ms** | 22 ms | 79 ms | 52 ms |
| `arithmetic` | **0.7 ms** | 3.4 ms | 95 ms | 63 ms |
| `stats` | **1.5 ms** | 4.7 ms | 22 ms | 31 ms |
| `value_counts` | **7.3 ms** | 12 ms | 12 ms | 37 ms |
| `to_csv` | 124 ms | 85 ms | **52 ms** | 147 ms |

### 1,000,000 rows

| Task | pandasx | Arquero | danfo.js | Data-Forge |
|---|---:|---:|---:|---:|
| `read_csv` | 1.17 s | **975 ms** | 2.32 s | 3.29 s |
| `construct` | 174 ms | **<0.1 ms** | 294 ms | 1.11 s |
| `filter` | **38 ms** | 41 ms | 512 ms | 112 ms |
| `sort` | **125 ms** | 721 ms | 168.10 s | 2.11 s |
| `groupby` | **132 ms** | 202 ms | 701 ms | 3.04 s |
| `merge` | **155 ms** | 219 ms | 1.04 s | 527 ms |
| `arithmetic` | **17 ms** | 19 ms | 1.10 s | 1.05 s |
| `stats` | **32 ms** | 34 ms | 196 ms | 235 ms |
| `value_counts` | **55 ms** | 125 ms | 116 ms | 357 ms |
| `to_csv` | 1.26 s | 949 ms | **574 ms** | 2.12 s |
