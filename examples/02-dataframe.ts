// DataFrame: building frames, inspecting them and changing their shape.
// Run: node 02-dataframe.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

title('From columns, records or rows');
const byColumns = new pd.DataFrame({ store: ['SP01', 'RJ01'], area_m2: [120, 140] });
const byRecords = new pd.DataFrame([{ store: 'SP01', area_m2: 120 }, { store: 'RJ01' }]);
const byRows = new pd.DataFrame([['SP01', 120], ['RJ01', 140]], { columns: ['store', 'area_m2'] });
console.log(byColumns);
console.log(byRecords);
console.log(byRows.equals(byColumns));

title('Reading a CSV');
const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'] });
console.log(sales.head());
console.log('shape:', sales.shape);
console.log(sales.dtypes);

title('info and describe');
console.log(sales.info());
console.log(sales.describe());

title('Index');
const stores = pd.readJson(new URL('data/stores.json', import.meta.url)).setIndex('store');
console.log(stores);
console.log('index name:', stores.index.name, '| labels:', stores.index.toArray());
console.log(stores.resetIndex().head(2));

title('Adding, renaming and removing columns');
const df = stores.copy();
df.set('area_ft2', df.get('area_m2').mul(10.764).round(0));
df.insert(0, 'region', ['SE', 'SE', 'SE', 'SE', 'S']);
console.log(df.rename({ columns: { area_m2: 'm2' } }).drop(['manager', 'opened']));
console.log('popped:', df.pop('region').toArray());

title('Iterating');
for (const [label, row] of stores.head(2).iterrows()) console.log(label, row);
console.log(stores.head(2).toRecords());

title('Transpose');
console.log(stores.get(['city', 'area_m2']).head(2).T);
