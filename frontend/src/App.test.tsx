import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { ExecuteResponse } from "./api";

// Mock the API client so the component is tested in isolation from the network.
vi.mock("./api", () => ({ execute: vi.fn(), fetchAuthConfig: vi.fn() }));
import { execute, fetchAuthConfig } from "./api";

// Mock Auth0 so we can drive the auth state without a provider.
vi.mock("@auth0/auth0-react", () => ({ useAuth0: vi.fn() }));
import { useAuth0 } from "@auth0/auth0-react";

const mockedExecute = vi.mocked(execute);
const mockedFetchAuthConfig = vi.mocked(fetchAuthConfig);
const mockedUseAuth0 = vi.mocked(useAuth0);

const loginWithRedirect = vi.fn();
const logout = vi.fn();
const getAccessTokenSilently = vi.fn();

function setAuth(overrides: Record<string, unknown> = {}) {
  mockedUseAuth0.mockReturnValue({
    isLoading: false,
    isAuthenticated: true,
    user: { email: "dev@example.com" },
    loginWithRedirect,
    logout,
    getAccessTokenSilently,
    ...overrides,
  } as unknown as ReturnType<typeof useAuth0>);
}

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

function runButton() {
  return screen.getByRole("button", { name: /Run/ });
}

describe("App", () => {
  beforeEach(() => {
    mockedExecute.mockReset();
    mockedFetchAuthConfig.mockReset();
    mockedFetchAuthConfig.mockResolvedValue({ authRequired: true });
    getAccessTokenSilently.mockReset();
    getAccessTokenSilently.mockResolvedValue("test-token");
    setAuth(); // authenticated by default
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading state while Auth0 initializes", () => {
    setAuth({ isLoading: true });
    render(<App />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows a login button and hides the prompt when unauthenticated", () => {
    setAuth({ isAuthenticated: false, user: undefined });
    render(<App />);
    expect(screen.getByRole("button", { name: /Log in/ })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("triggers Auth0 login when the login button is clicked", async () => {
    const user = userEvent.setup();
    setAuth({ isAuthenticated: false, user: undefined });
    render(<App />);
    await user.click(screen.getByRole("button", { name: /Log in/ }));
    expect(loginWithRedirect).toHaveBeenCalledTimes(1);
  });

  it("allows anonymous use (no login wall, no token) when the backend doesn't require auth", async () => {
    const user = userEvent.setup();
    mockedFetchAuthConfig.mockResolvedValue({ authRequired: false });
    mockedExecute.mockResolvedValue({ type: "message", message: "ran anon" });
    setAuth({ isAuthenticated: false, user: undefined });
    render(<App />);

    // Once the config loads, the prompt is usable without logging in.
    const textbox = await screen.findByRole("textbox");
    await user.type(textbox, "do a thing");
    await user.click(runButton());

    await waitFor(() => expect(mockedExecute).toHaveBeenCalledWith("do a thing", undefined));
    expect(getAccessTokenSilently).not.toHaveBeenCalled();
    expect(await screen.findByText(/ran anon/)).toBeInTheDocument();
  });

  it("shows the user and logs out when authenticated", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByText("dev@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Log out/ }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

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

  it("calls execute with the prompt and a fresh access token, and renders a result", async () => {
    const user = userEvent.setup();
    mockedExecute.mockResolvedValue(resultResponse);
    render(<App />);

    await user.type(screen.getByRole("textbox"), "compute things");
    await user.click(runButton());

    await waitFor(() => expect(getAccessTokenSilently).toHaveBeenCalled());
    expect(mockedExecute).toHaveBeenCalledWith("compute things", "test-token");
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
