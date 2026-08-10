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

/** Errors do not survive JSON.stringify (message/stack are non-enumerable) — unwrap them. */
function normalize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] =
      value instanceof Error
        ? { message: value.message, stack: value.stack, name: value.name }
        : value;
  }
  return out;
}

/**
 * JSON.stringify that tolerates the two values a log field realistically arrives as and
 * JSON cannot represent: a circular reference and a BigInt.
 *
 * Circular refs are replaced IN PLACE rather than allowed to throw. A logging call must never
 * take the process down — but it must also never lose `severity`/`message`, because those are
 * what make a line filterable, and the fail-open quota alarm this logger carries (ADR-0003 S9)
 * is worthless if it lands as an unfilterable blob.
 */
function stringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, val: unknown) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return typeof val === "bigint" ? val.toString() : val;
    }) ?? "null"
  );
}

export function makeLogger(format: LogFormat, sink: (line: string) => void): Logger {
  const emit = (severity: Severity, message: string, fields?: Fields): void => {
    const normalized = fields ? normalize(fields) : {};
    if (format === "json") {
      let line: string;
      try {
        line = stringify({ severity, message, ...normalized });
      } catch {
        // Last resort — a throwing getter, say. Keep the two fields that make a line filterable.
        line = JSON.stringify({ severity, message, unserializableFields: true });
      }
      sink(line);
      return;
    }
    let suffix = "";
    if (Object.keys(normalized).length) {
      try {
        suffix = ` ${stringify(normalized)}`;
      } catch {
        suffix = ` {"unserializableFields":true}`;
      }
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
 * This reads process.env directly rather than getSettings(). That is load-bearing: config.ts
 * imports dotenv, and a logger importing config.ts would create a cycle the moment config.ts
 * wanted to log. `logFormat` still appears in Settings because that is where configuration is
 * documented.
 */
export const log: Logger = makeLogger(
  (process.env.LOG_FORMAT as LogFormat) === "json" ? "json" : "text",
  (line) => console.log(line),
);
