import React, { useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { execute, type ExecuteResponse } from "./api";

export default function App() {
  const { isLoading, isAuthenticated, user, loginWithRedirect, logout, getAccessTokenSilently } =
    useAuth0();

  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<ExecuteResponse | null>(null);

  async function onRun() {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResponse(null);
    try {
      const token = await getAccessTokenSilently();
      setResponse(await execute(prompt, token));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  if (isLoading) {
    return (
      <div style={styles.page}>
        <p style={styles.sub}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.h1}>LLM Code Execution</h1>
        {isAuthenticated && (
          <div style={styles.userBox}>
            <span style={styles.userEmail}>{user?.email ?? user?.name}</span>
            <button
              style={styles.secondaryButton}
              onClick={() => void logout({ logoutParams: { returnTo: window.location.origin } })}
            >
              Log out
            </button>
          </div>
        )}
      </div>

      <p style={styles.sub}>
        Describe a task. If it calls for code, it's generated and run in an isolated sandbox.
      </p>

      {!isAuthenticated ? (
        <button style={styles.button} onClick={() => void loginWithRedirect()}>
          Log in to run code
        </button>
      ) : (
        <>
          <textarea
            style={styles.textarea}
            placeholder="e.g. compute the first 20 Fibonacci numbers"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void onRun();
            }}
          />
          <button
            style={styles.button}
            onClick={() => void onRun()}
            disabled={loading || !prompt.trim()}
          >
            {loading ? "Running…" : "Run  (⌘/Ctrl + Enter)"}
          </button>

          {error && <div style={styles.error}>⚠️ {error}</div>}

          {response?.type === "message" && (
            <div style={styles.messageBanner}>💬 {response.message}</div>
          )}

          {response?.type === "result" && (
            <div>
              <Section title={`Generated code (${response.language})`}>
                <pre style={styles.code}>{response.code}</pre>
              </Section>

              <div style={styles.meta}>
                exit code: <b>{response.exit_code}</b> · {response.duration_ms} ms
                {response.timed_out && <span style={styles.timeout}> · timed out</span>}
              </div>

              {response.stdout && (
                <Section title="Output (stdout)">
                  <pre style={styles.output}>{response.stdout}</pre>
                </Section>
              )}
              {response.stderr && (
                <Section title="Errors (stderr)">
                  <pre style={styles.stderr}>{response.stderr}</pre>
                </Section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 20 }}>
      <div style={styles.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 760,
    margin: "40px auto",
    padding: "0 20px",
    fontFamily: "system-ui, sans-serif",
    color: "#1a1a1a",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 16,
  },
  userBox: { display: "flex", alignItems: "center", gap: 10 },
  userEmail: { fontSize: 13, color: "#666" },
  h1: { fontSize: 26, marginBottom: 4 },
  sub: { color: "#666", marginTop: 0 },
  textarea: {
    width: "100%",
    minHeight: 110,
    padding: 12,
    fontSize: 15,
    fontFamily: mono,
    borderRadius: 8,
    border: "1px solid #ccc",
    boxSizing: "border-box",
    resize: "vertical",
  },
  button: {
    marginTop: 12,
    padding: "10px 18px",
    fontSize: 15,
    borderRadius: 8,
    border: "none",
    background: "#2563eb",
    color: "white",
    cursor: "pointer",
  },
  secondaryButton: {
    padding: "6px 12px",
    fontSize: 13,
    borderRadius: 6,
    border: "1px solid #ccc",
    background: "white",
    color: "#1a1a1a",
    cursor: "pointer",
  },
  error: {
    marginTop: 20,
    padding: 12,
    borderRadius: 8,
    background: "#fef2f2",
    color: "#991b1b",
    border: "1px solid #fecaca",
  },
  messageBanner: {
    marginTop: 20,
    padding: 14,
    borderRadius: 8,
    background: "#eff6ff",
    color: "#1e40af",
    border: "1px solid #bfdbfe",
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#555",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  code: {
    background: "#0f172a",
    color: "#e2e8f0",
    padding: 14,
    borderRadius: 8,
    overflowX: "auto",
    fontFamily: mono,
    fontSize: 13,
    margin: 0,
  },
  output: {
    background: "#f8fafc",
    padding: 14,
    borderRadius: 8,
    overflowX: "auto",
    fontFamily: mono,
    fontSize: 13,
    margin: 0,
    border: "1px solid #e2e8f0",
  },
  stderr: {
    background: "#fff7ed",
    color: "#9a3412",
    padding: 14,
    borderRadius: 8,
    overflowX: "auto",
    fontFamily: mono,
    fontSize: 13,
    margin: 0,
    border: "1px solid #fed7aa",
  },
  meta: { marginTop: 12, fontSize: 13, color: "#666" },
  timeout: { color: "#b91c1c", fontWeight: 600 },
};
