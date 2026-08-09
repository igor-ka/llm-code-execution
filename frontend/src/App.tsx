import React, { useCallback, useEffect, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { errorMessage, execute, fetchAuthConfig, type ExecuteResponse } from "./api";
import {
  clearHistory,
  deleteRun,
  deleteSession,
  getSession,
  listSessions,
  renameSession,
  type RunView,
  type SessionDetail,
  type SessionSummary,
} from "./history";
import { HistorySidebar } from "./components/HistorySidebar";
import { SessionView } from "./components/SessionView";
import { RunResult } from "./components/RunResult";

export default function App() {
  const { isLoading, isAuthenticated, user, loginWithRedirect, logout, getAccessTokenSilently } =
    useAuth0();

  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<ExecuteResponse | null>(null);
  // Whether the backend enforces auth. Defaults to true (fail secure) until the backend
  // tells us otherwise, so the UI never shows an open mode the server doesn't actually allow.
  const [authRequired, setAuthRequired] = useState(true);
  // Whether per-user history is available (auth on + a datastore configured). Defaults off.
  const [historyEnabled, setHistoryEnabled] = useState(false);

  // History state (only meaningful when the sidebar is shown).
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let active = true;
    fetchAuthConfig()
      .then((cfg) => {
        if (!active) return;
        setAuthRequired(cfg.authRequired);
        setHistoryEnabled(cfg.historyEnabled);
      })
      .catch(() => {
        /* keep the secure defaults */
      });
    return () => {
      active = false;
    };
  }, []);

  const showHistory = historyEnabled && isAuthenticated;

  // Fetch a fresh access token only when signed in; anonymous mode sends no token.
  const getToken = useCallback(
    (): Promise<string | undefined> =>
      isAuthenticated ? getAccessTokenSilently() : Promise.resolve(undefined),
    [isAuthenticated, getAccessTokenSilently],
  );

  const refreshSessions = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const page = await listSessions(token, query);
    setSessions(page.sessions);
  }, [getToken, query]);

  // Load the session list once history is available, and whenever the search query changes.
  useEffect(() => {
    if (!showHistory) return;
    let active = true;
    void (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const page = await listSessions(token, query);
        if (active) setSessions(page.sessions);
      } catch {
        /* transient list error — leave the current list in place */
      }
    })();
    return () => {
      active = false;
    };
  }, [showHistory, getToken, query]);

  // Load the selected session's runs. The pane derives its runs from `detail` only when its id
  // matches `selectedId`, so a still-loading (or stale) detail never shows another session.
  useEffect(() => {
    if (!showHistory || !selectedId) return;
    let active = true;
    void (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const d = await getSession(token, selectedId);
        if (active) setDetail(d);
      } catch {
        if (active) setDetail(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [showHistory, selectedId, getToken]);

  // Runs of the pane's currently-selected session: only when the loaded detail is that session.
  const selectedRuns = detail && detail.id === selectedId ? detail.runs : [];

  // The fallback (no-history) run path: one-shot execute with the result shown inline.
  async function onRun() {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResponse(null);
    try {
      const token = await getToken();
      setResponse(await execute(prompt, token));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  // Append a just-executed run to the open session; if it created a new session, select it so
  // the detail refetch loads it. Either way refresh the sidebar (ordering, run counts, titles).
  function handleRun(run: RunView) {
    const sid = run.session_id;
    setDetail((prev) => {
      if (prev && prev.id === sid) return { ...prev, runs: [...prev.runs, run] };
      return {
        id: sid || (selectedId ?? ""),
        title: run.prompt,
        created_at: run.created_at,
        updated_at: run.created_at,
        runs: [run],
      };
    });
    if (sid && sid !== selectedId) setSelectedId(sid);
    void refreshSessions().catch(() => {
      /* non-fatal: the run already ran and is shown */
    });
  }

  async function handleRename(id: string, title: string) {
    const token = await getToken();
    if (!token) return;
    await renameSession(token, id, title);
    await refreshSessions();
  }

  async function handleDelete(id: string) {
    const token = await getToken();
    if (!token) return;
    await deleteSession(token, id);
    if (selectedId === id) {
      setSelectedId(null);
      setDetail(null);
    }
    await refreshSessions();
  }

  async function handleClear() {
    const token = await getToken();
    if (!token) return;
    await clearHistory(token);
    setSessions([]);
    setSelectedId(null);
    setDetail(null);
  }

  async function handleDeleteRun(runId: string) {
    const token = await getToken();
    if (!token) return;
    setDetail((prev) => (prev ? { ...prev, runs: prev.runs.filter((r) => r.id !== runId) } : prev));
    try {
      await deleteRun(token, runId);
    } catch {
      /* best-effort: the row is gone from view; a stale entry reappears on refetch */
    }
    await refreshSessions();
  }

  if (isLoading) {
    return (
      <div style={styles.page}>
        <p style={styles.sub}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={showHistory ? styles.pageWide : styles.page}>
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

      {showHistory ? (
        <div style={styles.layout}>
          <HistorySidebar
            sessions={sessions}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
            onNew={() => {
              setSelectedId(null);
              setDetail(null);
            }}
            onRename={(id, title) => void handleRename(id, title)}
            onDelete={(id) => void handleDelete(id)}
            onClear={() => void handleClear()}
            onSearch={(q) => setQuery(q)}
          />
          <SessionView
            key={selectedId ?? "new"}
            runs={selectedRuns}
            selectedId={selectedId}
            getToken={getToken}
            onRun={handleRun}
            onDeleteRun={(runId) => void handleDeleteRun(runId)}
          />
        </div>
      ) : (
        <>
          <p style={styles.sub}>
            Describe a task. If it calls for code, it's generated and run in an isolated sandbox.
          </p>

          {authRequired && !isAuthenticated ? (
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

              {response && <RunResult response={response} />}
            </>
          )}
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 760,
    margin: "40px auto",
    padding: "0 20px",
    fontFamily: "system-ui, sans-serif",
    color: "#1a1a1a",
  },
  pageWide: {
    maxWidth: 1040,
    margin: "40px auto",
    padding: "0 20px",
    fontFamily: "system-ui, sans-serif",
    color: "#1a1a1a",
  },
  layout: { display: "flex", gap: 20, marginTop: 20, alignItems: "flex-start" },
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
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
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
};
