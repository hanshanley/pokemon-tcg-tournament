import { readFileSync } from 'node:fs';
import { catalog, runBattle } from './core.js';
export * from './core.js';

if (typeof require !== 'undefined' && require.main === module) {
  const output = process.stdout.write.bind(process.stdout);
  console.log = (...values) => process.stderr.write(`${values.join(' ')}\n`);
  console.warn = console.log;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (!['catalog', 'battle'].includes(input.mode)) throw new Error('Unknown engine operation.');
    output(JSON.stringify(input.mode === 'catalog' ? catalog() : runBattle(input)));
  } catch (error) {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  }
}
