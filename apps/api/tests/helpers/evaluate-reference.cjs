// Frozen before stage 12; tests never rewrite the reference.
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const source = require('../fixtures/evaluate-before-stage12.json');
const filename = path.resolve(__dirname, '../../dist/scheduling/test-reference-evaluate.js');
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
  referenceEvaluation: (s) => new loaded.exports.SchedulingController(s),
  evaluationPayload: (value) =>
    JSON.parse(JSON.stringify(value, (key, item) => (key === 'evaluatedAt' ? undefined : item))),
};
