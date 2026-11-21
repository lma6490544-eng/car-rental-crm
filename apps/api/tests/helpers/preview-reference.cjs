// Captured before stage 11. Application code never loads or updates this source.
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const source = require('../fixtures/preview-before-stage11.json');
const filename = path.resolve(__dirname, '../../dist/scheduling/test-reference-preview.js');
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
module.exports = {
  referencePreview: (s) => new loaded.exports.SchedulingController(s),
  // All commercial, business date, array and token fields stay in the comparison.
  previewPayload: (value) =>
    JSON.parse(
      JSON.stringify(value, (key, item) =>
        key === 'evaluatedAt' || key === 'markedAt' ? undefined : item,
      ),
    ),
};
