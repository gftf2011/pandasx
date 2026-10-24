// SQL: write and read tables with Node's built-in SQLite (node:sqlite).
// The same calls accept better-sqlite3, pg or mysql2 connections.
// Run: node 15-io-sql.ts
import { DatabaseSync } from 'node:sqlite';
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

const db = new DatabaseSync(':memory:');
const sales = pd.readCsv(new URL('data/sales.csv', import.meta.url), { parseDates: ['date'] });
const stores = pd.readJson(new URL('data/stores.json', import.meta.url));

title('toSql: create tables');
console.log('sales rows written:', await sales.toSql('sales', db, { index: false }));
console.log('stores rows written:', await stores.toSql('stores', db, { index: false, dtype: { area_m2: 'INTEGER' } }));
console.log(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all().map((r) => (r as { name: string }).name));

title('ifExists: fail / replace / append');
try {
  await stores.toSql('stores', db, { index: false });
} catch (e) {
  console.log('fail (default):', (e as Error).message);
}
await stores.head(1).toSql('stores', db, { index: false, ifExists: 'append' });
console.log('after append:', (await pd.readSqlQuery('SELECT COUNT(*) AS n FROM stores', db)).iat(0, 0));
await stores.toSql('stores', db, { index: false, ifExists: 'replace' });
console.log('after replace:', (await pd.readSqlQuery('SELECT COUNT(*) AS n FROM stores', db)).iat(0, 0));

title('readSqlTable');
console.log(await pd.readSqlTable('stores', db, { indexCol: 'store', columns: ['city', 'area_m2'] }));

title('readSql with parameters and parsed dates');
const query = `
  SELECT s.store, st.city, SUM(s.units * s.unit_price) AS revenue, MAX(s.date) AS last_sale
  FROM sales s JOIN stores st ON st.store = s.store
  WHERE s.category = ?
  GROUP BY s.store, st.city
  ORDER BY revenue DESC`;
const coffee = await pd.readSql(query, db, { params: ['coffee'], parseDates: ['last_sale'], indexCol: 'store' });
console.log(coffee);
console.log(coffee.dtypes);

title('readSqlChunks: stream a query');
for await (const chunk of pd.readSqlChunks('SELECT * FROM sales ORDER BY date', db, { chunksize: 60, parseDates: ['date'] })) {
  console.log('chunk of', chunk.length, 'rows, first date', chunk.get('date').iat(0));
}

title('Round trip with the index');
const perStore = sales.groupby('store').get('units').sum().toFrame();
await perStore.toSql('units_per_store', db, { indexLabel: 'store' });
console.log(await pd.readSqlTable('units_per_store', db, { indexCol: 'store' }));

db.close();
