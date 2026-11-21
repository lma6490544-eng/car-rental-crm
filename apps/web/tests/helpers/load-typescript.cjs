const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const cache = new Map();

// Pure TS modules now share helpers; resolve those imports without emitting files.
function loadTypescript(filename) {
  filename = path.resolve(filename);
  if (cache.has(filename)) return cache.get(filename).exports;
  const loaded = new Module(filename, module);
  cache.set(filename, loaded);
  const nativeRequire = Module.createRequire(filename);
  loaded.require = (specifier) => {
    if (specifier.startsWith('.')) {
      const target = path.resolve(path.dirname(filename), specifier) + '.ts';
      if (fs.existsSync(target)) return loadTypescript(target);
    }
    return nativeRequire(specifier);
  };
  loaded._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    filename,
  );
  return loaded.exports;
}
module.exports = { loadTypescript };
