// Content-Security-Policy builder for the served app.
//
// The production policy is strict: `script-src 'self'` (no inline/eval — the meaningful
// XSS defense, which matters because the access token lives in JS memory), framing denied,
// plugins denied, and network egress limited to our own origin, the backend API, and the
// Auth0 tenant (its token endpoint + the silent-auth iframe). `style-src 'unsafe-inline'`
// is allowed because the app uses React inline `style` objects; inline styles are far lower
// risk than inline scripts.
//
// The dev policy additionally allows `'unsafe-eval'`/inline and the HMR websocket, which the
// Vite dev server needs.

export interface CspOptions {
  apiBase: string;
  auth0Domain: string;
  dev?: boolean;
}

export function buildCsp({ apiBase, auth0Domain, dev = false }: CspOptions): string {
  const auth0Origin = auth0Domain ? `https://${auth0Domain}` : "";

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": dev ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"] : ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'", apiBase, auth0Origin, dev ? "ws:" : ""],
    "frame-src": [auth0Origin],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
  };

  return Object.entries(directives)
    .map(([name, values]) => {
      const present = values.filter(Boolean);
      return present.length ? `${name} ${present.join(" ")}` : "";
    })
    .filter(Boolean)
    .join("; ");
}
