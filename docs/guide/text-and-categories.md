# Text & categories

## String methods: `.str`

`series.str` is pandas' vectorised string API. Missing values stay missing; boolean predicates on the `string` dtype return `false` for missing values (as in pandas 3).

```ts run
import * as pd from 'pandasx';

const s = new pd.Series(['  Ana Maria ', 'bruno', null, 'CARLA-souza']);
console.log(s.str.strip().str.title().toArray());
console.log(s.str.lower().str.contains('a').toArray());
console.log(s.str.len().toArray());
console.log(s.str.replace(/[aeiou]/gi, '*').toArray());
console.log(s.str.startswith('b').toArray());
```

```text
[ 'Ana Maria', 'Bruno', null, 'Carla-Souza' ]
[ true, false, false, true ]
[ 12, 5, NaN, 11 ]
[ '  *n* M*r** ', 'br*n*', null, 'C*RL*-s**z*' ]
[ false, true, false, false ]
```

### Splitting and extracting

```ts run
import * as pd from 'pandasx';

const s = new pd.Series(['2024-01-15 sale', '2023-12-02 refund']);
console.log(s.str.split(' ').str.get(1).toArray());
console.log(s.str.split('-', { n: 1, expand: true }));
console.log(s.str.extract(/(?<year>\d{4})-(?<month>\d{2})/));
console.log(new pd.Series(['a1b22', 'c333']).str.findall(/\d+/).toArray());
console.log(new pd.Series(['a1b2', 'c3']).str.extractall(/(\d)/));
```

```text
[ 'sale', 'refund' ]
      0             1
0  2024    01-15 sale
1  2023  12-02 refund
   year  month
0  2024     01
1  2023     12
[ [ '1', '22' ], [ '333' ] ]
          0
   match
0  0      1
0  1      2
1  0      3
```

### Formatting and predicates

```ts run
import * as pd from 'pandasx';

const s = new pd.Series(['7', '42', 'abc']);
console.log(s.str.zfill(4).toArray(), s.str.pad(5, 'both', '*').toArray());
console.log(s.str.isnumeric().toArray(), s.str.isalpha().toArray());
console.log(new pd.Series(['the quick brown fox']).str.wrap(10).iat(0));
console.log(new pd.Series(['red|blue', 'blue']).str.getDummies());
console.log(new pd.Series(['a', 'b']).str.cat(['x', 'y'], { sep: '-' }).toArray());
```

```text
[ '0007', '0042', '0abc' ] [ '**7**', '**42*', '*abc*' ]
[ true, true, false ] [ false, false, true ]
the quick
brown fox
   blue  red
0     1    1
1     1    0
[ 'a-x', 'b-y' ]
```

The full list: `lower`, `upper`, `title`, `capitalize`, `swapcase`, `casefold`, `normalize`, `strip`, `lstrip`, `rstrip`, `removeprefix`, `removesuffix`, `pad`, `center`, `ljust`, `rjust`, `zfill`, `wrap`, `len`, `contains`, `match`, `fullmatch`, `startswith`, `endswith`, `isalnum`, `isalpha`, `isdecimal`, `isdigit`, `isnumeric`, `isspace`, `islower`, `isupper`, `istitle`, `count`, `find`, `rfind`, `index`, `rindex`, `findall`, `extract`, `extractall`, `replace`, `slice`, `sliceReplace`, `repeat`, `translate`, `split`, `rsplit`, `partition`, `rpartition`, `get`, `join`, `cat`, `getDummies`, `encode`, `decode`.

## Categoricals: `category` dtype

Categoricals store each value as an integer code into a list of categories — compact, and ordered when the order matters:

```ts run
import * as pd from 'pandasx';

const size = pd.categorical(['M', 'S', 'L', 'M'], { categories: ['S', 'M', 'L'], ordered: true });
console.log(size.dtype, size.cat.categories, size.cat.codes.toArray());
console.log(size.sortValues().toArray());
console.log(size.gt('S').toArray(), size.max());
console.log(size.valueCounts());
```

```text
category [ 'S', 'M', 'L' ] [ 1, 0, 2, 1 ]
[ 'S', 'M', 'M', 'L' ]
[ true, false, true, true ] L
M  2
S  1
L  1
Name: count, dtype: int64
```

Convert with `astype('category')` (categories are sorted unless given). The `.cat` accessor manages categories:

```ts run
import * as pd from 'pandasx';

const s = new pd.Series(['x', 'y', 'x']).astype('category');
console.log(s.cat.renameCategories({ x: 'ex' }).toArray());
console.log(s.cat.addCategories(['z']).cat.categories);
console.log(s.cat.removeCategories(['y']).toArray());
console.log(s.cat.setCategories(['y', 'x'], { ordered: true }).sortValues().toArray());
console.log(s.cat.asOrdered().cat.ordered);
```

```text
[ 'ex', 'y', 'ex' ]
[ 'x', 'y', 'z' ]
[ 'x', null, 'x' ]
[ 'y', 'x', 'x' ]
true
```

Grouping by a categorical uses its category order, and `valueCounts` lists unused categories with a zero count.
