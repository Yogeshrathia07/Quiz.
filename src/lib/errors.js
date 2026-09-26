/**
 * The single error type every service throws. `server.js` maps `status` onto the
 * HTTP response, so a service never needs to know about Express.
 */
export class PublicTestError extends Error {
  /** `code` is optional: a stable name the client can act on, e.g. OTHER_DEVICE. */
  constructor(status, message, code = null) {
    super(message);
    this.name = 'PublicTestError';
    this.status = status;
    this.code = code;
  }
}
