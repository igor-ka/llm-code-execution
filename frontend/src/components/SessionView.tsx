import React, { useState } from "react";
import { execute } from "../api";
import type { RunView } from "../history";
import { RunResult } from "./RunResult";

export interface SessionViewProps {
  // Runs of the selected session, oldest first. Empty for a brand-new chat.
  runs: RunView[];
  // The session being continued, or null to start a new one on the next run.
  selectedId: string | null;
  getToken: () => Promise<string | undefined>;
  // Called after a successful run with a display-ready RunView; the parent appends it and, if
  // the response carried a fresh session_id, refreshes the sidebar and selects the session.
  onRun: (run: RunView) => void;
  // Delete a single persisted run. Omitted for runs that were never persisted.
  onDeleteRun?: (runId: string) => void;
}

// The main pane: the selected session's runs (each prompt + its result) followed by the prompt
// form. Historical and just-executed runs render through the same <RunResult>.
export function SessionView({ runs, selectedId, getToken, onRun, onDeleteRun }: SessionViewProps) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const resp = await execute(prompt, token, selectedId ?? undefined);
      const run: RunView = {
        ...resp,
        id: resp.run_id ?? `local-${Date.now()}`,
        session_id: resp.session_id ?? selectedId ?? "",
        created_at: new Date().toISOString(),
        prompt,
      };
      onRun(run);
      setPrompt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section style={styles.session} aria-label="Session">
      <div style={styles.runs}>
        {runs.length === 0 && (
          <p style={styles.empty}>
            {selectedId ? "This conversation has no runs yet." : "Start a new conversation below."}
          </p>
        )}
        {runs.map((run) => (
          <div key={run.id} style={styles.runBlock}>
            <div style={styles.promptRow}>
              <div style={styles.promptEcho}>{run.prompt}</div>
              {onDeleteRun && (
                <button
                  style={styles.deleteRun}
                  aria-label="Delete run"
                  onClick={() => onDeleteRun(run.id)}
                >
                  ✕
                </button>
              )}
            </div>
            <RunResult response={run} />
          </div>
        ))}
      </div>

      <textarea
        style={styles.textarea}
        placeholder="e.g. compute the first 20 Fibonacci numbers"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <button
        style={styles.button}
        onClick={() => void submit()}
        disabled={loading || !prompt.trim()}
      >
        {loading ? "Running…" : "Run  (⌘/Ctrl + Enter)"}
      </button>

      {error && <div style={styles.error}>⚠️ {error}</div>}
    </section>
  );
}

const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const styles: Record<string, React.CSSProperties> = {
  session: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  runs: { display: "flex", flexDirection: "column", gap: 24, marginBottom: 20 },
  empty: { color: "#999", fontSize: 14 },
  runBlock: { borderBottom: "1px solid #f1f5f9", paddingBottom: 16 },
  promptRow: { display: "flex", alignItems: "flex-start", gap: 8 },
  promptEcho: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    fontWeight: 600,
    color: "#1a1a1a",
    background: "#f8fafc",
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
    whiteSpace: "pre-wrap",
  },
  deleteRun: {
    flexShrink: 0,
    padding: "4px 8px",
    fontSize: 12,
    borderRadius: 6,
    border: "1px solid #ddd",
    background: "white",
    color: "#555",
    cursor: "pointer",
  },
  textarea: {
    width: "100%",
    minHeight: 90,
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
    alignSelf: "flex-start",
    padding: "10px 18px",
    fontSize: 15,
    borderRadius: 8,
    border: "none",
    background: "#2563eb",
    color: "white",
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
};
