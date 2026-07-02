/** An error carrying an HTTP status and a `detail` string (the shape the SPA reads). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(detail);
    this.name = "HttpError";
  }
}
