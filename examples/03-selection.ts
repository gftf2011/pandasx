// Selecting and assigning: get / loc / iloc / at / iat, boolean masks, query and eval.
// Run: node 03-selection.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

const stores = pd.readJson(new URL('data/stores.json', import.meta.url)).setIndex('store');

title('Columns: df.get');
console.log(stores.get('city').toArray());                 // df['city']
console.log(stores.get(['city', 'area_m2']));              // df[['city', 'area_m2']]

title('Labels: df.loc');
console.log(stores.loc('RJ01'));                            // one row -> Series
console.log(stores.loc('RJ01', 'city'));                    // one cell
console.log(stores.loc(['SP01', 'BH01'], ['city', 'state']));
console.log(stores.loc(pd.slice('SP02', 'BH01')).index.toArray()); // inclusive, like pandas
console.log(stores.loc(null, pd.slice('state', 'area_m2')).columns);

title('Positions: df.iloc');
console.log(stores.iloc(0, 0));
console.log(stores.iloc(pd.slice(1, 3)).index.toArray());   // end-exclusive
console.log(stores.iloc([0, -1], [0, 3]));

title('Single values: at / iat');
console.log(stores.at('POA01', 'area_m2'), stores.iat(1, 0));

title('Boolean masks');
const area = stores.get('area_m2');
console.log(stores.get(area.gt(90)).index.toArray());                                    // df[df.area_m2 > 90]
console.log(stores.get(area.gt(90).and(stores.get('state').ne('RJ'))).index.toArray()); // & and !=
console.log(stores.get(stores.get('state').isin(['SP', 'RS'])).index.toArray());
console.log(stores.get(area.between(80, 130)).index.toArray());
console.log(stores.loc((d) => d.get('manager').isna(), 'city').toArray());              // callable selector

title('query and eval with pandas expression strings');
const minArea = 90;
console.log(stores.query('area_m2 >= @minArea and state in ["SP", "RJ"]', { locals: { minArea } }));
console.log(stores.query('city.str.contains("o") and not (state == "RS")').index.toArray());
console.log((stores.eval('area_m2 * 10.764') as pd.Series).round(0).toArray());
console.log((stores.eval('seats = area_m2 / 2.5') as pd.DataFrame).get('seats').toArray());

title('Selecting columns by name or dtype');
console.log(stores.filter({ like: 'a' }).columns);
console.log(stores.filter({ regex: '^(city|state)$' }).columns);
console.log(stores.selectDtypes({ include: ['number'] }).columns);

title('Assigning: set, setLoc, setIloc, setAt, assign');
const df = stores.copy();
df.set('active', true);                                     // broadcast a scalar
df.setLoc(df.get('area_m2').lt(80), 'active', false);       // masked rows
df.setAt('BH01', 'manager', 'Elisa Prado');                 // one cell
df.setLoc('CWB01', ['city', 'state', 'area_m2'], ['Curitiba', 'PR', 60]); // enlarge with a new row
df.setIloc(0, 3, 125);
console.log(df);
console.log(stores.assign({ density: (d) => d.get('area_m2').div(10) }).get('density').toArray());

title('Sampling, head/tail, reindex');
console.log(stores.head(2).index.toArray(), stores.tail(1).index.toArray());
console.log(stores.sample(2, { seed: 7 }).index.toArray());
console.log(stores.reindex({ index: ['RJ01', 'XX99'] }));
