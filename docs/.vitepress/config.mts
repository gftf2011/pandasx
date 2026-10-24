import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';

const apiSidebar = JSON.parse(readFileSync(new URL('../api/typedoc-sidebar.json', import.meta.url), 'utf8'));

const guide = [
  {
    text: 'Introduction',
    items: [
      { text: 'Getting started', link: '/guide/getting-started' },
      { text: 'Coming from pandas', link: '/guide/coming-from-pandas' },
    ],
  },
  {
    text: 'Essentials',
    items: [
      { text: 'Data structures & dtypes', link: '/guide/data-structures' },
      { text: 'Selecting & assigning', link: '/guide/selection' },
      { text: 'Missing data', link: '/guide/missing-data' },
      { text: 'Computation & statistics', link: '/guide/computation' },
      { text: 'Text & categories', link: '/guide/text-and-categories' },
    ],
  },
  {
    text: 'Analysis',
    items: [
      { text: 'Group by', link: '/guide/groupby' },
      { text: 'Reshaping & MultiIndex', link: '/guide/reshaping' },
      { text: 'Combining data', link: '/guide/merging' },
      { text: 'Time series', link: '/guide/time-series' },
    ],
  },
  {
    text: 'Input, output & presentation',
    items: [
      { text: 'Reading & writing data', link: '/guide/io' },
      { text: 'Plotting', link: '/guide/plotting' },
      { text: 'Styling tables', link: '/guide/styling' },
      { text: 'Display options', link: '/guide/options' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'Differences from pandas', link: '/guide/differences' },
      { text: 'API reference', link: '/api/' },
    ],
  },
];

export default defineConfig({
  title: 'pandasx',
  description: 'pandas-style DataFrame and Series for Node.js, written in TypeScript',
  base: '/pandasx/',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  head: [['link', { rel: 'icon', href: '/pandasx/favicon.svg', type: 'image/svg+xml' }]],
  themeConfig: {
    logo: '/favicon.svg',
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'API', link: '/api/', activeMatch: '/api/' },
      { text: 'Examples', link: 'https://github.com/gftf2011/pandasx/tree/main/examples' },
      { text: 'npm', link: 'https://www.npmjs.com/package/pandasx' },
    ],
    sidebar: {
      '/guide/': guide,
      '/api/': [{ text: 'API reference', link: '/api/', items: apiSidebar }],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/gftf2011/pandasx' }],
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    editLink: { pattern: 'https://github.com/gftf2011/pandasx/edit/main/docs/:path', text: 'Edit this page on GitHub' },
    footer: { message: 'Released under the MIT License.' },
  },
});
