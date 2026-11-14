import { build } from 'esbuild';
import path from 'node:path';

await build({
  entryPoints: ['web/app.js'],
  outfile: path.resolve(process.argv[2], 'static/app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  logLevel: 'info',
});
