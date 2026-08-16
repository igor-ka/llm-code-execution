/**
 * Structured logging.
 *
 * In a container platform, logs are the only debugger you have. Cloud Logging (and most
 * aggregators) parse a single JSON object per line and promote `severity` and `message` to
 * first-class, filterable fields; everything else becomes structured metadata. Locally that is
 * unreadable, so `text` stays the default and `LOG_FORMAT=json` opts in.
 *
 * Deliberately dependency-free and tiny: one emit path, injectable sink for tests.
 */

export type LogFormat = "json" | "text";
type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

/** Guard against a pathological `cause` chain; five links is far more than anything real. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Errors do not survive JSON.stringify — `message` and `stack` are non-enumerable — so unwrap
 * them by hand.
 *
 * `cause` and `AggregateError.errors` are unwrapped too, and that is not decoration: node-redis
 * reports a failed connection as an AggregateError whose own message is the useless "All promises
 * were rejected", with the actual ECONNREFUSED in `errors`. Dropping them would make the
 * fail-open quota alarm fire while saying nothing about *why* Redis is unreachable — the one
 * thing an operator needs at 3am.
 */
/**
 * Error fields that carry ROW CONTENT rather than diagnosis, and so must never reach a log.
 *
 * Postgres' DETAIL on a constraint violation is `Failing row contains (...)` — the entire row. On
 * `runs` that is the user's prompt, the generated code and its stdout/stderr; on `sessions` it is
 * the verified `sub`. `server.ts` logs exactly those insert failures (`history persist failed`),
 * so lifting DETAIL would write user content into the log stream and undo the owner-isolation the
 * history store exists to enforce. `where`, `internalQuery` and `query` embed the failing
 * statement for the same reason.
 *
 * Everything that identifies WHAT broke — code, severity, constraint, table, column, schema,
 * position, routine — is not here and is preserved.
 */
const REDACTED_ERROR_FIELDS = new Set(["detail", "where", "internalQuery", "query"]);

function fromError(err: Error, depth = 0): Record<string, unknown> {
  // Own enumerable properties FIRST, then message/stack/name overlaid on top.
  //
  // The overlay order is the point: those three are non-enumerable on a plain Error, so they must
  // be lifted explicitly — but an Error subclass may also define them as own properties, and the
  // explicit unwrapping has to win. Everything else is what subclasses hang off the instance, and
  // for pg's DatabaseError that is the diagnosis: `code` (the SQLSTATE, the only stable thing to
  // alert on), `position` (the byte offset into the failing SQL), `constraint` and `table`.
  // Dropping them turns a crash-looping migration into `column "foo" does not exist` and nothing
  // else.
  //
  // `cause` is always skipped here, and an ARRAY `errors` too; both are unwrapped below where the
  // depth cap lives. `new Error(m, {cause})` makes cause non-enumerable, but `err.cause = other`
  // makes it enumerable — and that form would otherwise reach safeValue, which walks deeply with
  // cycle protection but NO depth limit, so a long chain would be walked in full before
  // MAX_CAUSE_DEPTH could apply. A non-array `errors` is ordinary data and IS lifted: validation
  // libraries use that shape, and dropping it would lose the whole payload.
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(err)) {
    if (key === "cause") continue;
    if (REDACTED_ERROR_FIELDS.has(key)) continue;
    let value: unknown;
    // Reading is a getter call, and this function sits on the path that must never throw.
    // A throwing getter costs its own field, not the whole log line.
    try {
      value = (err as unknown as Record<string, unknown>)[key];
    } catch {
      out[key] = "[unreadable]";
      continue;
    }
    if (key === "errors" && Array.isArray(value)) continue;
    // Nested Errors need fromError, not safeValue: safeValue walks Object.entries, and a plain
    // Error has none, so an Error-valued property would serialize as `{}` — a line that LOOKS
    // like it captured the failure while holding nothing. node-redis hangs `originalError` and
    // `socketError` off its errors exactly this way.
    //
    // The cap is applied HERE, not at the shared check below: that one runs after this loop, so
    // it cannot gate the loop's own recursion. `err.originalError = err` would otherwise recurse
    // until the stack blew and the entry collapsed to `unserializableFields`, losing even the
    // message. At the cap, keep the shallow identity rather than dropping the field.
    if (value instanceof Error) {
      out[key] =
        depth < MAX_CAUSE_DEPTH
          ? fromError(value, depth + 1)
          : { message: value.message, name: value.name };
      continue;
    }
    out[key] = safeValue(value, new Set());
  }
  out.message = err.message;
  out.stack = err.stack;
  out.name = err.name;
  if (depth >= MAX_CAUSE_DEPTH) return out;
  if (err.cause !== undefined) {
    out.cause =
      err.cause instanceof Error
        ? fromError(err.cause, depth + 1)
        : safeValue(err.cause, new Set());
  }
  const aggregate = (err as AggregateError).errors;
  if (Array.isArray(aggregate)) {
    out.errors = aggregate.map((e) =>
      e instanceof Error ? fromError(e, depth + 1) : safeValue(e, new Set()),
    );
  }
  return out;
}

function normalize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? fromError(value) : value;
  }
  return out;
}

/**
 * Deep-copy a value into something JSON can represent, replacing only genuine cycles.
 *
 * `ancestors` is scoped to the current PATH — added on descent, removed on ascent. A shared
 * WeakSet that is never popped would report the second sibling reference to the same object as
 * "[Circular]", which is not a cycle at all: logging two records that share a principal, or an
 * array of rows sharing a sub-object, would silently lose real diagnostic data and claim a cycle
 * that does not exist.
 */
function safeValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return undefined;
  if (typeof value !== "object" || value === null) return value;

  // Honour toJSON (Date, and anything else that defines it) before walking own properties —
  // Object.entries(new Date()) is empty, so a naive walk would turn every timestamp into {}.
  const maybe = value as { toJSON?: unknown };
  if (typeof maybe.toJSON === "function") {
    return (maybe as { toJSON: () => unknown }).toJSON();
  }

  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => safeValue(item, ancestors));
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = safeValue(val, ancestors);
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/** A logging call must never take the process down, whatever it was handed. */
function stringify(value: unknown): string {
  return JSON.stringify(safeValue(value, new Set())) ?? "null";
}

export function makeLogger(format: LogFormat, sink: (line: string) => void): Logger {
  const emit = (severity: Severity, message: string, fields?: Fields): void => {
    // normalize() READS caller-supplied properties, so it can throw on a hostile or merely
    // exotic getter. It therefore lives inside the try alongside serialization — leaving it
    // outside would let an exception escape the one function that must never throw, turning an
    // error-reporting path into a second error.
    if (format === "json") {
      let line: string;
      try {
        const normalized = fields ? normalize(fields) : {};
        // severity/message are spread LAST so they always win. A caller field named `message` is
        // entirely natural — log.error("x", { message: err.message }) — and if it overwrote the
        // real one, an ERROR line would vanish from every `severity>=ERROR` filter. The two
        // fields that make a line findable are not negotiable by its payload.
        line = stringify({ ...normalized, severity, message });
      } catch {
        line = JSON.stringify({ severity, message, unserializableFields: true });
      }
      sink(line);
      return;
    }
    let suffix = "";
    try {
      const normalized = fields ? normalize(fields) : {};
      if (Object.keys(normalized).length) suffix = ` ${stringify(normalized)}`;
    } catch {
      suffix = ` {"unserializableFields":true}`;
    }
    sink(`${severity.padEnd(5)} ${message}${suffix}`);
  };

  return {
    debug: (m, f) => emit("DEBUG", m, f),
    info: (m, f) => emit("INFO", m, f),
    warn: (m, f) => emit("WARNING", m, f),
    error: (m, f) => emit("ERROR", m, f),
  };
}

/**
 * Process-wide logger. Everything goes to stdout: Cloud Run captures both streams, and the
 * `severity` field — not the stream — is what drives log-level filtering.
 *
 * The format is resolved LAZILY, on first use, and can be set explicitly by the composition root
 * via configureLogger(). Both matter: this module deliberately does not import config.ts (which
 * loads dotenv and would create a cycle the moment config wanted to log), so reading process.env
 * at module-evaluation time would make `LOG_FORMAT` in the repo-root .env depend on whether some
 * other module happened to import config.ts first. It works today only by import order, which is
 * not something to rely on.
 */
let configured: LogFormat | undefined;

export function configureLogger(format: LogFormat): void {
  configured = format;
}

function currentFormat(): LogFormat {
  if (configured) return configured;
  return (process.env.LOG_FORMAT as LogFormat) === "json" ? "json" : "text";
}

function emitVia(severity: keyof Logger, message: string, fields?: Fields): void {
  makeLogger(currentFormat(), (line) => console.log(line))[severity](message, fields);
}

export const log: Logger = {
  debug: (m, f) => emitVia("debug", m, f),
  info: (m, f) => emitVia("info", m, f),
  warn: (m, f) => emitVia("warn", m, f),
  error: (m, f) => emitVia("error", m, f),
};
