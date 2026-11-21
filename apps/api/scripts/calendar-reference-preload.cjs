// Diagnostic baseline only: NODE_OPTIONS propagates this to the test's HTTP child.
// No application entry point imports this file.
const { CalendarService } = require('../dist/scheduling/calendar.service');
const { referenceCalendar } = require('../tests/helpers/calendar-reference.cjs');
const references = new WeakMap();
CalendarService.prototype.get = function (query) {
  if (!references.has(this))
    references.set(this, referenceCalendar(this.db, this.scheduling.commands, this.scheduling));
  return references.get(this).get(query);
};
