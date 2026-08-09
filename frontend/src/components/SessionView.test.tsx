import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionView } from "./SessionView";
import type { RunView } from "../history";

// Isolate the component from the network.
// Keep the real module and stub only execute: ApiError must be a real class (SessionView's
// error formatting does an instanceof check) and errorMessage must be the real implementation.
vi.mock("../api", async (importActual) => ({
  ...(await importActual<typeof import("../api")>()),
  execute: vi.fn(),
}));
import { ApiError, execute } from "../api";
const mockedExecute = vi.mocked(execute);

// A stand-in parent that owns the runs list, mirroring how App wires SessionView: onRun
// appends the returned run so we can assert it renders.
function Harness({
  selectedId,
  initialRuns = [],
  onDeleteRun,
}: {
  selectedId: string | null;
  initialRuns?: RunView[];
  onDeleteRun?: (id: string) => void;
}) {
  const [runs, setRuns] = useState<RunView[]>(initialRuns);
  return (
    <SessionView
      runs={runs}
      selectedId={selectedId}
      getToken={() => Promise.resolve("tok")}
      onRun={(r) => setRuns((prev) => [...prev, r])}
      onDeleteRun={onDeleteRun}
    />
  );
}

function runButton() {
  return screen.getByRole("button", { name: /Run/ });
}

describe("SessionView", () => {
  beforeEach(() => {
    mockedExecute.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders existing runs (prompt + result)", () => {
    const runs: RunView[] = [
      {
        type: "result",
        language: "python",
        code: "print('hi')",
        stdout: "hi\n",
        stderr: "",
        exit_code: 0,
        duration_ms: 5,
        timed_out: false,
        id: "r1",
        session_id: "s1",
        created_at: "t",
        prompt: "say hi",
      },
    ];
    render(<Harness selectedId="s1" initialRuns={runs} />);
    expect(screen.getByText("say hi")).toBeInTheDocument();
    expect(screen.getByText(/Generated code \(python\)/)).toBeInTheDocument();
    expect(screen.getByText("print('hi')")).toBeInTheDocument();
  });

  it("submits with the current session id and renders the new run", async () => {
    const user = userEvent.setup();
    mockedExecute.mockResolvedValue({
      type: "message",
      message: "no code needed",
      session_id: "s1",
      run_id: "r9",
    });
    render(<Harness selectedId="s1" />);

    await user.type(screen.getByRole("textbox"), "compute things");
    await user.click(runButton());

    await waitFor(() => expect(mockedExecute).toHaveBeenCalledWith("compute things", "tok", "s1"));
    expect(await screen.findByText(/no code needed/)).toBeInTheDocument();
  });

  it("starts a new session (no session id) when none is selected", async () => {
    const user = userEvent.setup();
    mockedExecute.mockResolvedValue({
      type: "message",
      message: "ok",
      session_id: "new",
      run_id: "r1",
    });
    render(<Harness selectedId={null} />);

    await user.type(screen.getByRole("textbox"), "first prompt");
    await user.click(runButton());

    await waitFor(() =>
      expect(mockedExecute).toHaveBeenCalledWith("first prompt", "tok", undefined),
    );
  });

  it("clears the textarea after a successful run", async () => {
    const user = userEvent.setup();
    mockedExecute.mockResolvedValue({ type: "message", message: "ok" });
    render(<Harness selectedId="s1" />);

    const textbox = screen.getByRole("textbox");
    await user.type(textbox, "do it");
    await user.click(runButton());

    await waitFor(() => expect(textbox).toHaveValue(""));
  });

  it("shows an error banner when execute rejects", async () => {
    const user = userEvent.setup();
    mockedExecute.mockRejectedValue(new Error("backend exploded"));
    render(<Harness selectedId="s1" />);

    await user.type(screen.getByRole("textbox"), "trigger error");
    await user.click(runButton());

    expect(await screen.findByText(/backend exploded/)).toBeInTheDocument();
  });

  it("explains a 429 with its retry hint in the history path too (D7)", async () => {
    const user = userEvent.setup();
    mockedExecute.mockRejectedValue(new ApiError(429, "Rate limit exceeded.", 42));
    render(<Harness selectedId="s1" />);

    await user.type(screen.getByRole("textbox"), "too fast");
    await user.click(runButton());

    // This is the PRIMARY authenticated UX. It previously showed the raw backend detail and
    // dropped the retry hint entirely, because the formatter lived in App's fallback path only.
    expect(await screen.findByText(/sending requests too quickly/i)).toBeInTheDocument();
    expect(screen.getByText(/Try again in 42s/)).toBeInTheDocument();
  });

  it("does not rewrite a 503 that carries no retry hint", async () => {
    const user = userEvent.setup();
    mockedExecute.mockRejectedValue(new ApiError(503, "ANTHROPIC_API_KEY is not configured"));
    render(<Harness selectedId="s1" />);

    await user.type(screen.getByRole("textbox"), "misconfigured");
    await user.click(runButton());

    expect(await screen.findByText(/ANTHROPIC_API_KEY is not configured/)).toBeInTheDocument();
  });

  it("calls onDeleteRun when a run's delete button is clicked", async () => {
    const user = userEvent.setup();
    const onDeleteRun = vi.fn();
    const runs: RunView[] = [
      { type: "message", message: "hi", id: "r1", session_id: "s1", created_at: "t", prompt: "p" },
    ];
    render(<Harness selectedId="s1" initialRuns={runs} onDeleteRun={onDeleteRun} />);

    await user.click(screen.getByRole("button", { name: /Delete run/ }));
    expect(onDeleteRun).toHaveBeenCalledWith("r1");
  });
});
