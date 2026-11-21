const { readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const suite = process.argv[2];
if (!['api', 'web', 'all'].includes(suite)) {
  throw new Error('Usage: node scripts/run-tests.cjs api|web|all');
}
const root = resolve(__dirname, '..');
const suites = suite === 'all' ? ['api', 'web'] : [suite];
const files = suites.flatMap((name) => {
  const directory = resolve(root, 'apps', name, 'tests');
  const tests = readdirSync(directory)
    .filter((file) => file.endsWith('.cjs'))
    .sort();
  if (!tests.length) throw new Error(`No tests found in ${directory}`);
  return tests.map((file) => resolve(directory, file));
});

// Explicit paths work on Windows without shell glob expansion. Serial execution
// avoids contention between database, browser and API acceptance suites.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
