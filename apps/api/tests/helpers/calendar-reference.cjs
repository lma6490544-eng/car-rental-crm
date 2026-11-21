// Frozen pre-optimization oracle. Never used by application code.
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const source = require('../fixtures/calendar-before-stage5.json');
function compile(text, file) {
  const filename = path.resolve(__dirname, '../../dist/scheduling', file);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded._compile(
    ts.transpileModule(text, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    }).outputText,
    filename,
  );
  return loaded.exports;
}
const LegacyScheduling = compile(
  source.schedulingSource,
  'test-reference-scheduling.js',
).SchedulingService;
const LegacyCalendar = compile(source.calendarSource, 'test-reference-calendar.js').CalendarService;
function referenceCalendar(db, commands, scheduling) {
  const reference = new LegacyScheduling(db, commands);
  reference.tokenKey = scheduling.tokenKey; // Compare HMAC values too; no key is logged or exposed.
  return new LegacyCalendar(db, reference);
}
const calendarPayload = (value) =>
  JSON.parse(JSON.stringify(value, (key, item) => (key === 'evaluatedAt' ? undefined : item)));
module.exports = { referenceCalendar, calendarPayload };
