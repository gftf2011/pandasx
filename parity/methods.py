import json, math, sys
import numpy as np, pandas as pd
out = {}
def conv(x):
    if x is None or x is pd.NA or x is pd.NaT: return None
    if isinstance(x, float) and math.isnan(x): return None
    if isinstance(x, (pd.Timestamp, pd.Timedelta, pd.Period)): return str(x)
    if isinstance(x, tuple): return [conv(i) for i in x]
    if isinstance(x, list): return [conv(i) for i in x]
    if hasattr(x, 'item'): return conv(x.item())
    return x
def put(k, v):
    if isinstance(v, pd.DataFrame): v = {'columns': [str(c) for c in v.columns], 'index': [conv(i) for i in v.index], 'values': [[conv(c) for c in r] for r in v.values.tolist()]}
    elif isinstance(v, (pd.Series, pd.Index)): v = [conv(x) for x in v.tolist()]
    else: v = conv(v)
    out[k] = v
s = pd.Series([3, 1, 4, 1, 5, np.nan, 9, 2, 6, 5])
for m in ['average', 'min', 'max', 'first', 'dense']: put(f'rank_{m}', s.rank(method=m))
put('rank_pct_desc_top', s.rank(pct=True, ascending=False, na_option='top'))
x = pd.Series([1.0, 2, 3, 4, 5, 6, 7]); y = pd.Series([2.0, 1, 4, 3, 7, 5, 6])
put('corr_p', x.corr(y)); put('corr_s', x.corr(y, method='spearman')); put('corr_k', x.corr(y, method='kendall'))
put('cov', x.cov(y)); put('autocorr2', y.autocorr(2))
df = pd.DataFrame({'a': x, 'b': y, 'c': x ** 2})
put('df_corr_k', df.corr(method='kendall')); put('df_cov', df.cov())
z = pd.Series([np.nan, 1.0, np.nan, np.nan, 4.0, 9.0, np.nan, 25.0, np.nan])
for m in ['linear', 'nearest', 'zero', 'pad', 'quadratic', 'cubic', 'pchip', 'akima']:
    try: put(f'interp_{m}', z.interpolate(method=m))
    except Exception as e: put(f'interp_{m}', 'ERR')
put('interp_poly2', z.interpolate(method='polynomial', order=2))
put('interp_limit_both', z.interpolate(limit=1, limit_direction='both'))
put('interp_outside', z.interpolate(limit_area='outside', limit_direction='both'))
zi = pd.Series([0.0, np.nan, 10.0, np.nan, 40.0], index=[0, 1, 5, 6, 10])
put('interp_index', zi.interpolate(method='index'))
put('skewdf', df.skew()); put('kurtdf', df.kurt())
st = pd.Series(['Ana Maria', 'bruno', None, 'CARLA-souza', '  x  ', 'a1b22c333'])
put('str_title', st.str.title()); put('str_cap', st.str.capitalize()); put('str_swap', st.str.swapcase())
put('str_center', st.str.center(13, '*')); put('str_zfill', pd.Series(['-5', '42', '+3']).str.zfill(5))
put('str_count', st.str.count('a')); put('str_find', st.str.find('a')); put('str_rfind', st.str.rfind('a'))
put('str_isalnum', st.str.isalnum()); put('str_isupper', st.str.isupper()); put('str_istitle', st.str.istitle())
put('str_split_n', st.str.split(' ', n=1).map(lambda v: v if isinstance(v, list) else None))
put('str_rsplit', pd.Series(['a-b-c']).str.rsplit('-', n=1).tolist())
put('str_extract', st.str.extract(r'([a-z])(\d+)'))
put('str_slice_step', st.str.slice(0, None, 2)); put('str_slice_replace', st.str.slice_replace(1, 3, 'XX'))
put('str_wrap', pd.Series(['the quick brown fox jumps']).str.wrap(10))
put('str_replace_n', pd.Series(['aaaa']).str.replace('a', 'b', n=2)); put('str_replace_re', pd.Series(['a1b22']).str.replace(r'(\d+)', r'<\1>', regex=True))
put('str_dummies', pd.Series(['a|b', 'b', None]).str.get_dummies())
put('str_len', st.str.len()); put('str_strip_chars', pd.Series(['xxhixx']).str.strip('x'))
put('str_pad_both', pd.Series(['ab']).str.pad(5, side='both', fillchar='-'))
g = pd.DataFrame({'k': ['a', 'b', 'a', 'b', 'a', 'b', 'a'], 'v': [1.0, 10, 2, np.nan, 3, 30, 4]})
G = g.groupby('k')['v']
put('g_shift', G.shift()); put('g_diff', G.diff()); put('g_pct', G.pct_change(fill_method=None)); put('g_rank', G.rank())
put('g_cumprod', G.cumprod()); put('g_ffill', G.ffill()); put('g_nth1', G.nth(1)); put('g_quant', G.quantile(0.25))
put('g_describe', G.describe()); put('g_ngroup', g.groupby('k').ngroup()); put('g_cumcount_desc', g.groupby('k').cumcount(ascending=False))
put('g_sem', G.sem()); put('g_idxmin', G.idxmin())
d2 = pd.DataFrame({'a': [1, 2, 3, 4], 'b': ['x', 'y', 'x', 'z'], 'c': [10.0, 20, 30, 40]})
put('q1', d2.query('a > 1 and b != "z"')); put('q2', d2.query('b in ["x", "z"] | c >= 30')); put('q3', d2.query('1 < a <= 3 and not b == "y"'))
put('q4', d2.query('c / a == 10 and a % 2 == 0')); put('q5', d2.query('b.str.contains("x") or index == 3'))
put('ev1', d2.eval('a * 2 + c ** 0.5')); put('ev2', d2.eval('d = a + c'))
json.dump(out, sys.stdout)
