---
layout: home

hero:
  name: pandasx
  text: pandas for Node.js
  tagline: Typed, columnar DataFrame and Series with the pandas API you already know — checked against real pandas.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Coming from pandas
      link: /guide/coming-from-pandas
    - theme: alt
      text: API reference
      link: /api/

features:
  - title: The pandas API, in TypeScript
    details: loc / iloc, groupby, merge, pivot_table, resample, rolling, .str, .dt, .cat, query strings — with camelCase names and full typings.
  - title: Fast, typed columns
    details: Numbers and dates live in Float64Array, booleans in Uint8Array, categories in Int32Array. Nullable Int64 / Float64 / boolean and exact bigint integers.
  - title: Verified against pandas
    details: 214 parity cases compare results with pandas 3.1, and fixture files written by pandas are read back in the test suite.
  - title: Every format
    details: CSV (streaming, compressed, from URLs), JSON, Excel, Parquet, Feather/Arrow, HDF5, SQL, HTML, XML, LaTeX and Markdown.
  - title: Time series
    details: Calendar offsets, business days, IANA time zones with DST handling, resampling, rolling / expanding / ewm windows.
  - title: Charts and styled tables
    details: Accessible SVG plots with light and dark themes, and a pandas-compatible Styler for HTML, LaTeX and Excel.
---
