// Post-processes the TypeDoc output in api/.
//
// VitePress treats any `index.md` (case-insensitively) as a directory index, so
// the page of the `Index` class (classes/Index.md) would be unreachable. It is
// renamed to classes/Index-class.md and every link and sidebar entry follows.
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const api = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');
renameSync(join(api, 'classes', 'Index.md'), join(api, 'classes', 'Index-class.md'));

function files(dir) {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
}

for (const file of files(api)) {
  if (!/\.(md|json)$/.test(file)) continue;
  const src = readFileSync(file, 'utf8');
  const out = src
    .replace(/\]\(((?:\.\.\/|\.\/)*(?:classes\/)?)Index\.md/g, ']($1Index-class.md')
    .replace(/(["(/])classes\/Index(\.md)?(["#)])/g, '$1classes/Index-class$2$3');
  if (out !== src) writeFileSync(file, out);
}
