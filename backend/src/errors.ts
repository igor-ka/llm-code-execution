/** An error carrying an HTTP status and a `detail` string (the shape the SPA reads). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
    /** Seconds until the caller may retry — emitted as the Retry-After header. */
    public readonly retryAfterSeconds?: number,
  ) {
    super(detail);
    this.name = "HttpError";
  }
}
