/**
 * modules/customSources/sourceError.js
 *
 * A "known" problem with a custom source that we want to show in the
 * admin console logs (no link given, file too big, page blocked us, ...).
 *
 * code    : a fixed short name (e.g. MISSING_INPUT), used by the tests
 * message : a plain sentence the admin can read in View Logs
 *
 * Any OTHER error (a crash, database down) is not a SourceError. The run
 * still fails and logs it, but with a general message plus the error text.
 */

class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
  }
}

module.exports = { SourceError };
