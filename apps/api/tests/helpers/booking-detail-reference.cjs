// Independent controller captured before stage 13. Never rewritten by tests.
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const source = require('../fixtures/booking-detail-before-stage13.json');
const filename = path.resolve(__dirname, '../../dist/scheduling/test-reference-booking-detail.js');
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
  referenceDetail: (s) => new loaded.exports.SchedulingController(s),
  // Only the live evaluation timestamp is technical; stored snapshot dates stay.
  detailPayload: (value) => {
    const result = JSON.parse(JSON.stringify(value));
    if (result?.availability) delete result.availability.evaluatedAt;
    return result;
  },
};
