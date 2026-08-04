import React from "react";
import type { ExecuteResponse } from "../api";

// Renders a single run's output — the message banner or the generated-code / stdout / stderr
// blocks. Shared by the live run form and the historical session view so both draw runs
// identically. A persisted RunView is a superset of ExecuteResponse, so it fits here too.
export function RunResult({ response }: { response: ExecuteResponse }) {
  if (response.type === "message") {
    return <div style={styles.messageBanner}>💬 {response.message}</div>;
  }

  return (
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
