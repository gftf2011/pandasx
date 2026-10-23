"""Regenerates test/fixtures with real pandas (needs pandas, pyarrow, tables, openpyxl, lxml).

Usage: python parity/fixtures.py
"""
import os
import numpy as np, pandas as pd

out = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures')
os.makedirs(out, exist_ok=True)
df = pd.DataFrame({
    'i': [1, 2, 3], 'f': [1.5, np.nan, 3.0], 's': ['x', None, 'zzã'], 'b': [True, False, True],
    't': pd.to_datetime(['2024-01-01', '2024-01-02 10:00', None], format='ISO8601'),
}, index=pd.Index(['r1', 'r2', 'r3'], name='id'))
df.to_parquet(os.path.join(out, 'pandas.parquet'))
df.assign(n=pd.array([1, None, 3], dtype='Int64'), c=pd.Categorical(['a', 'b', 'a'])).reset_index().to_feather(os.path.join(out, 'pandas.feather'))
df.to_hdf(os.path.join(out, 'pandas_fixed.h5'), key='df', mode='w', complevel=9, complib='zlib')
df.to_hdf(os.path.join(out, 'pandas_table.h5'), key='df', mode='w', format='table', complevel=9, complib='zlib')
df.to_excel(os.path.join(out, 'pandas.xlsx'), sheet_name='data')
with open(os.path.join(out, 'pandas.html'), 'w') as fh: fh.write(df.to_html())
with open(os.path.join(out, 'pandas.xml'), 'w') as fh: fh.write(df.to_xml(parser='etree'))
df.to_json(os.path.join(out, 'pandas.json'), orient='table')
df.to_csv(os.path.join(out, 'pandas.csv.gz'))
print('fixtures written to', os.path.abspath(out))
