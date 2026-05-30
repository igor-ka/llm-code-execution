import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { ExecuteResponse } from "./api";

// Mock the API client so the component is tested in isolation from the network.
vi.mock("./api", () => ({ execute: vi.fn() }));
import { execute } from "./api";

const mockedExecute = vi.mocked(execute);

const resultResponse: ExecuteResponse = {
  type: "result",
  language: "python",
  code: "print('hi')",
  stdout: "hi\n",
  stderr: "boom",
  exit_code: 0,
  duration_ms: 123,
  timed_out: true,
};

describe("App", () => {
  beforeEach(() => {
    mockedExecute.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function runButton() {
    return screen.getByRole("button");
  }

  it("disables the Run button when the prompt is empty", () => {
    render(<App />);
    expect(runButton()).toBeDisabled();
  });

  it("enables the Run button once the prompt has content", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole("textbox"), "do a thing");
    expect(runButton()).toBeEnabled();
  });

  it("calls execute with the prompt and renders a result", async () => {
    const user = userEvent.setup();
    mockedExecute.mockResolvedValue(resultResponse);
    render(<App />);

    await user.type(screen.getByRole("textbox"), "compute things");
    await user.click(runButton());

    await waitFor(() => expect(mockedExecute).toHaveBeenCalledWith("compute things"));
    expect(await screen.findByText(/Generated code \(python\)/)).toBeInTheDocument();
    expect(screen.getByText("print('hi')")).toBeInTheDocument();
    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText(/timed out/)).toBeInTheDocument();
  });

  it("renders the message banner for a message response", async () => {
    const user = userEvent.setup();
    mockedExecute.mockResolvedValue({ type: "message", message: "no code needed here" });
    render(<App />);

    await user.type(screen.getByRole("textbox"), "say hi");
    await user.click(runButton());

    expect(await screen.findByText(/no code needed here/)).toBeInTheDocument();
  });

  it("renders an error banner when execute rejects", async () => {
    const user = userEvent.setup();
    mockedExecute.mockRejectedValue(new Error("backend exploded"));
    render(<App />);

    await user.type(screen.getByRole("textbox"), "trigger error");
    await user.click(runButton());

    expect(await screen.findByText(/backend exploded/)).toBeInTheDocument();
  });

  it("runs on Cmd/Ctrl+Enter but not on a plain Enter", async () => {
    const user = userEvent.setup();
    mockedExecute.mockResolvedValue({ type: "message", message: "ran" });
    render(<App />);

    const textbox = screen.getByRole("textbox");
    await user.type(textbox, "via keyboard");

    // Plain Enter should not trigger a run.
    await user.type(textbox, "{Enter}");
    expect(mockedExecute).not.toHaveBeenCalled();

    // Ctrl+Enter should.
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mockedExecute).toHaveBeenCalledTimes(1));
  });

  it("does not call execute when the prompt is only whitespace", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByRole("textbox"), "   ");
    // Button stays disabled, so trigger the run via the keyboard shortcut instead.
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(mockedExecute).not.toHaveBeenCalled();
  });
});
