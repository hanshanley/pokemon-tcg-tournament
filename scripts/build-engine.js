import { build } from 'esbuild';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const directory = path.resolve(process.env.TOURNAMENT_DATA_DIR ?? path.join(root, 'data'));
const manifest = JSON.parse(await readFile(path.join(root, 'engine/source.json'), 'utf8'));
const source = path.join(directory, 'engine/sources', manifest.commit, manifest.entry);
const bridge = createHash('sha256');
for (const filename of manifest.bridge_files) {
  bridge.update(`${filename}\0`);
  bridge.update(await readFile(path.join(root, filename)));
  bridge.update('\0');
}
const bridgeHash = bridge.digest('hex');
await mkdir(path.join(directory, 'engine'), { recursive: true });
const options = {
  alias: { '@engine': source },
  bundle: true,
  keepNames: true,
  metafile: true,
  logLevel: 'info',
  plugins: [
    {
      name: 'card-source-provenance',
      setup(plugin) {
        plugin.onLoad(
          {
            filter:
              /[/\\]prompts[/\\](?:shuffle-prompt|shuffle-hand-prompt|shuffle-prizes-prompt|order-cards-prompt)\.ts$/,
          },
          async ({ path: filename }) => {
            const contents = await readFile(filename, 'utf8');
            if (contents.split('s.sort();').length !== 2)
              throw new Error('Review upstream permutation validation before rebuilding.');
            // Upstream sorts numeric permutations lexicographically, rejecting decks of 11+ cards.
            return {
              contents: contents.replace('s.sort();', 's.sort((a, b) => a - b);'),
              loader: 'ts',
            };
          },
        );
        plugin.onLoad({ filter: /[/\\]sets[/\\].*\.ts$/ }, async ({ path: filename }) => {
          const contents = await readFile(filename, 'utf8');
          const classes = [...contents.matchAll(/^export\s+class\s+(\w+)\s+extends\s+/gm)];
          const metadata = JSON.stringify({
            path: path.relative(source, filename),
            sha256: createHash('sha256').update(contents).digest('hex'),
            incomplete: /\bTODO\b|not implemented|implement me/i.test(contents),
          });
          const annotations = classes
            .map(
              ([, name]) =>
                `Object.defineProperty(${name}, 'fieldnotesSource', {value: ${metadata}});`,
            )
            .join('\n');
          return { contents: `${contents}\n${annotations}`, loader: 'ts' };
        });
      },
    },
  ],
};
const result = await build({
  ...options,
  entryPoints: [path.join(root, 'engine/worker.js')],
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(directory, 'engine/worker.cjs'),
});
await build({
  ...options,
  entryPoints: [path.join(root, 'engine/browser-worker.js')],
  platform: 'browser',
  define: { global: 'globalThis' },
  format: 'iife',
  target: 'es2022',
  outfile: path.join(directory, 'engine/browser.js'),
});
const bundle = await readFile(path.join(directory, 'engine/worker.cjs'));
const bundleHash = createHash('sha256').update(bundle).digest('hex');
await mkdir(path.join(directory, 'engine/bundles'), { recursive: true });
await copyFile(
  path.join(directory, 'engine/worker.cjs'),
  path.join(directory, 'engine/bundles', `${bundleHash}.cjs`),
);
await writeFile(
  path.join(directory, 'engine/build.json'),
  JSON.stringify({
    ...manifest,
    bridge_sha256: bridgeHash,
    bundle_sha256: bundleHash,
    browser_sha256: createHash('sha256')
      .update(await readFile(path.join(directory, 'engine/browser.js')))
      .digest('hex'),
    inputs: Object.keys(result.metafile.inputs).length,
  }),
);
