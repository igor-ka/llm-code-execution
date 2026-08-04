import React, { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../history";

export interface HistorySidebarProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onSearch: (q: string) => void;
}

// Left rail: new-chat, debounced search, the owner's sessions, and per-session rename/delete
// plus a confirmed "Clear all". Purely presentational — all data + persistence lives in App.
export function HistorySidebar({
  sessions,
  selectedId,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onClear,
  onSearch,
}: HistorySidebarProps) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // Debounce search so each keystroke doesn't hit the network. Keep the latest onSearch in a
  // ref so the effect depends only on `query` (a new inline onSearch each render must not
  // re-arm the timer), and skip the initial mount so we don't fire an empty search.
  const onSearchRef = useRef(onSearch);
  useEffect(() => {
    onSearchRef.current = onSearch;
  });
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = setTimeout(() => onSearchRef.current(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  function startRename(s: SessionSummary) {
    setEditingId(s.id);
    setDraft(s.title);
  }

  function commitRename(id: string) {
    const title = draft.trim();
    if (title) onRename(id, title);
    setEditingId(null);
  }

  function confirmDelete(s: SessionSummary) {
    if (window.confirm(`Delete "${s.title}"?`)) onDelete(s.id);
  }

  function confirmClear() {
    if (sessions.length === 0) return;
    if (window.confirm("Delete all chat history? This cannot be undone.")) onClear();
  }

  return (
    <aside style={styles.sidebar} aria-label="Chat history">
      <button style={styles.newButton} onClick={onNew}>
        + New chat
      </button>

      <input
        type="search"
        aria-label="Search history"
        placeholder="Search history"
        style={styles.search}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <ul style={styles.list}>
        {sessions.length === 0 && <li style={styles.empty}>No conversations yet.</li>}
        {sessions.map((s) => {
          const selected = s.id === selectedId;
          return (
            <li key={s.id} style={styles.item}>
              {editingId === s.id ? (
                <div style={styles.renameRow}>
                  <input
                    aria-label="New title"
                    style={styles.renameInput}
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(s.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                  <button style={styles.miniButton} onClick={() => commitRename(s.id)}>
                    Save
                  </button>
                  <button style={styles.miniButton} onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={styles.itemRow}>
                  <button
                    style={{ ...styles.itemButton, ...(selected ? styles.itemButtonActive : {}) }}
                    onClick={() => onSelect(s.id)}
                    aria-current={selected ? "true" : undefined}
                  >
                    <span style={styles.itemTitle}>{s.title}</span>
                    <span style={styles.itemMeta}>
                      {relativeTime(s.updated_at)}
                      {typeof s.run_count === "number" ? ` · ${s.run_count}` : ""}
                    </span>
                  </button>
                  <button
                    style={styles.miniButton}
                    aria-label={`Rename ${s.title}`}
                    onClick={() => startRename(s)}
                  >
                    ✎
                  </button>
                  <button
                    style={styles.miniButton}
                    aria-label={`Delete ${s.title}`}
                    onClick={() => confirmDelete(s)}
                  >
                    ✕
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <button style={styles.clearButton} onClick={confirmClear} disabled={sessions.length === 0}>
        Clear all
      </button>
    </aside>
  );
}

// A compact "time since" label; falls back to a locale date past a week.
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: 240,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    borderRight: "1px solid #e5e7eb",
    paddingRight: 16,
  },
  newButton: {
    padding: "8px 12px",
    fontSize: 14,
    borderRadius: 8,
    border: "none",
    background: "#2563eb",
    color: "white",
    cursor: "pointer",
  },
  search: {
    padding: "6px 10px",
    fontSize: 13,
    borderRadius: 6,
    border: "1px solid #ccc",
    boxSizing: "border-box",
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    overflowY: "auto",
    flex: 1,
  },
  empty: { fontSize: 13, color: "#999", padding: "8px 4px" },
  item: { margin: 0 },
  itemRow: { display: "flex", alignItems: "center", gap: 2 },
  itemButton: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid transparent",
    background: "transparent",
    color: "#1a1a1a",
    cursor: "pointer",
    textAlign: "left",
  },
  itemButtonActive: { background: "#eff6ff", border: "1px solid #bfdbfe" },
  itemTitle: {
    fontSize: 14,
    fontWeight: 500,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "100%",
  },
  itemMeta: { fontSize: 11, color: "#888" },
  renameRow: { display: "flex", alignItems: "center", gap: 2 },
  renameInput: {
    flex: 1,
    minWidth: 0,
    padding: "5px 8px",
    fontSize: 13,
    borderRadius: 6,
    border: "1px solid #2563eb",
    boxSizing: "border-box",
  },
  miniButton: {
    padding: "4px 6px",
    fontSize: 12,
    borderRadius: 6,
    border: "1px solid #ddd",
    background: "white",
    color: "#555",
    cursor: "pointer",
  },
  clearButton: {
    padding: "6px 10px",
    fontSize: 13,
    borderRadius: 6,
    border: "1px solid #fecaca",
    background: "#fef2f2",
    color: "#991b1b",
    cursor: "pointer",
  },
};
