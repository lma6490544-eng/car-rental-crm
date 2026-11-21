// Frozen pre-stage-9 controller. Application code never loads this module.
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const source = require('../fixtures/technical-before-stage9.json');
const filename = path.resolve(__dirname, '../../dist/scheduling/test-reference-technical.js');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = module.paths;
loaded._compile(
  ts.transpileModule(source.controllerSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
    },
  }).outputText,
  filename,
);
module.exports = loaded.exports.SchedulingController;
