// Text data: the vectorised .str accessor.
// Run: node 06-text.ts
import * as pd from 'pandasx';

const title = (t: string) => console.log(`\n=== ${t} ===`);

const stores = pd.readJson(new URL('data/stores.json', import.meta.url));
const managers = stores.get('manager');

title('Cleaning');
console.log(managers.str.title().toArray());
console.log(managers.str.upper().toArray());
console.log(new pd.Series(['  latte ', 'Chai\t']).str.strip().str.lower().toArray());
console.log(new pd.Series(['#SP01', '#RJ01']).str.removeprefix('#').toArray());
console.log(new pd.Series(['São Paulo']).str.normalize('NFD').str.replace(/\p{M}/gu, '').toArray());

title('Searching');
console.log(stores.get('city').str.contains('Porto|Rio').toArray());          // a regex by default, like pandas
console.log(stores.get('city').str.contains('.', { regex: false }).toArray()); // plain substring
console.log(stores.get('city').str.startswith('B').toArray());
console.log(stores.get('store').str.match(/^SP\d+$/).toArray());
console.log(stores.get('city').str.count('o').toArray());
console.log(stores.get('city').str.find('o').toArray());

title('Splitting and extracting');
console.log(managers.str.split(' ').str.get(0).toArray());               // first names
console.log(managers.str.split(' ', { expand: true }));
console.log(stores.get('store').str.extract(/(?<state>[A-Z]+)(?<number>\d+)/));
console.log(stores.get('opened').str.extract(/^(\d{4})/).get('0').astype('int64').toArray());
console.log(new pd.Series(['2 lattes, 1 croissant', '3 espressos']).str.findall(/\d+/).toArray());
console.log(new pd.Series(['a1b2', 'c3']).str.extractall(/(?<digit>\d)/));
console.log(stores.get('city').str.partition(' '));

title('Formatting');
console.log(stores.get('area_m2').astype('string').str.zfill(4).toArray());
console.log(stores.get('store').str.pad(6, 'right', '.').toArray());
console.log(stores.get('store').str.center(9, '*').toArray());
console.log(stores.get('city').str.slice(0, 3).toArray());
console.log(stores.get('store').str.cat(stores.get('state'), { sep: '-' }).toArray());
console.log(new pd.Series(['a', 'b', 'c']).str.cat({ sep: '+' }));
console.log(new pd.Series(['Specialty coffee roasted daily in small batches']).str.wrap(20).iat(0));

title('Predicates and lengths');
console.log(new pd.Series(['123', '12a', '', 'ABC']).str.isnumeric().toArray());
console.log(new pd.Series(['123', '12a', '', 'ABC']).str.isupper().toArray());
console.log(stores.get('city').str.len().toArray());

title('Indicator columns from delimited strings');
console.log(new pd.Series(['wifi|parking', 'wifi', 'parking|terrace']).str.getDummies('|'));
