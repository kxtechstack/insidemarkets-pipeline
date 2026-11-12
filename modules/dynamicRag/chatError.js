/**
 * modules/dynamicRag/chatError.js
 *
 * A "known" problem that the chat wants to tell the user about
 * (empty question, user not allowed, ...).
 *
 * httpStatus : what the API sends back (400 = bad input, 403 = not allowed, ...)
 * code       : a fixed short name the frontend can check (e.g. EMPTY_QUESTION)
 * message    : plain sentence the user can read
 *
 * Any OTHER error (a crash, database down) is not a ChatError, and
 * route.js turns it into a general "something went wrong" reply.
 */

class ChatError extends Error {
  constructor(httpStatus, code, message) {
    super(message);
    this.name = 'ChatError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

module.exports = { ChatError };