// Frozen controller captured before stage 8; never loaded by application code.
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const source = require('../fixtures/move-before-stage8.json');
const filename = path.resolve(__dirname, '../../dist/scheduling/test-reference-move.js');
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
const ReferenceController = loaded.exports.SchedulingController;
const movePayload = (value) =>
  JSON.parse(
    JSON.stringify(value, (key, item) =>
      key === 'evaluatedAt' || key === 'markedAt' ? undefined : item,
    ),
  );
module.exports = {
  referenceMove: (s, bookings, calendar) => new ReferenceController(s, bookings, calendar),
  movePayload,
};
