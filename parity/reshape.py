import json, math, sys
import numpy as np, pandas as pd
out = {}
def conv(x):
    if x is None or x is pd.NA or x is pd.NaT: return None
    if isinstance(x, float) and math.isnan(x): return None
    if isinstance(x, (pd.Timestamp, pd.Timedelta, pd.Period, pd.Interval)): return str(x)
    if isinstance(x, (tuple, list)): return [conv(i) for i in x]
    if hasattr(x, 'item'): return conv(x.item())
    return x
def col(c): return [str(p) for p in c] if isinstance(c, tuple) else str(c)
def put(k, v):
    if isinstance(v, pd.DataFrame): v = {'columns': [col(c) for c in v.columns], 'index': [conv(i) for i in v.index], 'values': [[conv(c) for c in r] for r in v.astype(object).values.tolist()]}
    elif isinstance(v, (pd.Series, pd.Index)): v = {'index': [conv(i) for i in v.index], 'values': [conv(x) for x in v.tolist()]} if isinstance(v, pd.Series) else [conv(x) for x in v.tolist()]
    else: v = conv(v)
    out[k] = v
df = pd.DataFrame({'region': ['N', 'S', 'N', 'S', 'N', 'E'], 'prod': ['a', 'a', 'b', 'b', 'a', 'b'], 'units': [10, 5, 7, 3, 2, 4], 'price': [1.5, 2.0, 3.0, 1.0, 1.5, 2.5]})
m = df.set_index(['region', 'prod'])
put('mi_loc_partial', m.loc['N']); put('mi_loc_full', m.loc[('S', 'b')]); put('mi_xs_level', m.xs('a', level='prod'))
put('mi_droplevel', m.droplevel(0)); put('mi_swaplevel', m.swaplevel())
g = df.groupby(['region', 'prod'])['units'].sum()
put('unstack', g.unstack()); put('unstack_fill', g.unstack(fill_value=0)); put('unstack_level0', g.unstack(level=0))
put('stack_flat', df[['units', 'price']].head(2).stack())
w = df.groupby(['region', 'prod'])[['units', 'price']].sum().unstack()
put('df_unstack', w); put('df_stack_back', w.stack())
put('pivot', df.iloc[[0, 1, 2, 3]].pivot(index='region', columns='prod', values='units'))
put('pivot_multi_values', df.iloc[[0, 1, 2, 3]].pivot(index='region', columns='prod'))
put('pt_sum', pd.pivot_table(df, index='region', columns='prod', values='units', aggfunc='sum'))
put('pt_margins', pd.pivot_table(df, index='region', columns='prod', values='units', aggfunc='sum', margins=True, fill_value=0))
put('pt_multi_agg', pd.pivot_table(df, index='region', values=['units', 'price'], aggfunc=['sum', 'mean']))
put('pt_dict', pd.pivot_table(df, index='region', columns='prod', values=['units', 'price'], aggfunc={'units': 'sum', 'price': 'max'}))
put('pt_two_idx', pd.pivot_table(df, index=['region', 'prod'], values='units', aggfunc='count'))
put('ct', pd.crosstab(df['region'], df['prod'])); put('ct_margins', pd.crosstab(df['region'], df['prod'], margins=True))
put('ct_norm_index', pd.crosstab(df['region'], df['prod'], normalize='index')); put('ct_norm_all_m', pd.crosstab(df['region'], df['prod'], normalize='all', margins=True))
put('ct_values', pd.crosstab(df['region'], df['prod'], values=df['units'], aggfunc='mean'))
put('dummies_s', pd.get_dummies(pd.Series(['a', 'b', None, 'a']), dummy_na=True))
put('dummies_df', pd.get_dummies(df[['region', 'units']], prefix='r', drop_first=True))
x = pd.Series([1, 7, 5, 4, 6, 3, 10, 2])
put('cut3', pd.cut(x, 3).astype(str)); put('cut_edges', pd.cut(x, [0, 3, 6, 10]).astype(str))
put('cut_left', pd.cut(x, [1, 4, 7, 10], right=False).astype(str)); put('cut_lowest', pd.cut(x, [1, 4, 7, 10], include_lowest=True).astype(str))
put('cut_labels', pd.cut(x, [0, 5, 10], labels=['low', 'high']).astype(str)); put('cut_codes', pd.Series(pd.cut(x, [0, 5, 10], labels=False)))
put('qcut4', pd.qcut(x, 4).astype(str)); put('qcut_q', pd.qcut(x, [0, 0.5, 1]).astype(str))
put('factorize', list(pd.factorize(pd.Series(['b', 'a', None, 'b']))[0]))
put('explode', pd.DataFrame({'a': [[1, 2], [], [3]], 'b': ['x', 'y', 'z']}).explode('a'))
wl = pd.DataFrame({'id': [1, 2], 'A1970': [1.0, 2.0], 'A1980': [3.0, 4.0], 'B1970': [5.0, 6.0], 'B1980': [7.0, 8.0]})
put('wide_to_long', pd.wide_to_long(wl, ['A', 'B'], i='id', j='year'))
t = pd.DataFrame({'time': [1, 3, 5, 8], 'k': ['a', 'b', 'a', 'a'], 'v': [10, 20, 30, 40]})
q = pd.DataFrame({'time': [2, 3, 6, 9], 'k': ['a', 'a', 'b', 'a'], 'bid': [1.0, 2.0, 3.0, 4.0]})
put('asof_back', pd.merge_asof(t, q, on='time')); put('asof_fwd', pd.merge_asof(t, q, on='time', direction='forward'))
put('asof_near_by', pd.merge_asof(t, q, on='time', by='k', direction='nearest')); put('asof_tol', pd.merge_asof(t, q, on='time', tolerance=1, allow_exact_matches=False))
put('ordered', pd.merge_ordered(pd.DataFrame({'k': [1, 3, 5], 'a': [1.0, 2, 3]}), pd.DataFrame({'k': [2, 3, 4], 'b': [7.0, 8, 9]}), on='k', fill_method='ffill'))
L = pd.DataFrame({'v': [1, 2, 3]}, index=['x', 'y', 'z']); R = pd.DataFrame({'key': ['y', 'z', 'w'], 'w': [20, 30, 40]})
put('merge_li_ro', pd.merge(L, R, left_index=True, right_on='key')); put('merge_li_ri', pd.merge(L, R.set_index('key'), left_index=True, right_index=True, how='outer'))
a = pd.DataFrame({'p': [1.0, None, 3.0], 'q': [None, 5.0, None]}, index=[0, 1, 2]); b = pd.DataFrame({'p': [10.0, 20.0, 30.0, 40.0], 'r': [1, 2, 3, 4]}, index=[0, 1, 2, 3])
put('combine_first', a.combine_first(b))
u = a.copy(); u.update(pd.DataFrame({'p': [None, 9.0], 'q': [8.0, None]}, index=[1, 2])); put('update', u)
c1 = pd.DataFrame({'a': [1, 2, 3], 'b': ['x', 'y', 'z']}); c2 = pd.DataFrame({'a': [1, 5, 3], 'b': ['x', 'y', 'q']})
put('compare', c1.compare(c2)); put('compare_shape', c1.compare(c2, keep_shape=True))
put('gb_agg_list', df.groupby('region')[['units', 'price']].agg(['sum', 'max']))
put('mi_from_product', pd.MultiIndex.from_product([['a', 'b'], [1, 2]]).tolist())
json.dump(out, sys.stdout)
