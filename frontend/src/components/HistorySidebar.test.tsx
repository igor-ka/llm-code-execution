import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistorySidebar } from "./HistorySidebar";
import type { SessionSummary } from "../history";

const sessions: SessionSummary[] = [
  {
    id: "s1",
    title: "Fibonacci",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    run_count: 2,
  },
  {
    id: "s2",
    title: "Sort a list",
    created_at: "2026-08-02T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    run_count: 1,
  },
];

function setup(overrides: Partial<ComponentProps<typeof HistorySidebar>> = {}) {
  const props = {
    sessions,
    selectedId: null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onClear: vi.fn(),
    onSearch: vi.fn(),
    ...overrides,
  };
  render(<HistorySidebar {...props} />);
  return props;
}

describe("HistorySidebar", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders each session's title", () => {
    setup();
    expect(screen.getByText("Fibonacci")).toBeInTheDocument();
    expect(screen.getByText("Sort a list")).toBeInTheDocument();
  });

  it("shows an empty state when there are no sessions", () => {
    setup({ sessions: [] });
    expect(screen.getByText(/No conversations yet/)).toBeInTheDocument();
  });

  it("calls onSelect with the session id when a session is clicked", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByText("Fibonacci"));
    expect(props.onSelect).toHaveBeenCalledWith("s1");
  });

  it("calls onNew when New chat is clicked", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: /New chat/ }));
    expect(props.onNew).toHaveBeenCalledTimes(1);
  });

  it("debounces the search box and calls onSearch with the typed value", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.type(screen.getByRole("searchbox", { name: /Search history/ }), "fib");
    await waitFor(() => expect(props.onSearch).toHaveBeenCalledWith("fib"));
  });

  it("calls onDelete after the user confirms", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: /Delete Fibonacci/ }));
    expect(window.confirm).toHaveBeenCalled();
    expect(props.onDelete).toHaveBeenCalledWith("s1");
  });

  it("does not call onDelete when the user cancels the confirm", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: /Delete Fibonacci/ }));
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it("renames a session inline and calls onRename with the new title", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: /Rename Fibonacci/ }));
    const input = screen.getByRole("textbox", { name: /New title/ });
    await user.clear(input);
    await user.type(input, "Golden ratio");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(props.onRename).toHaveBeenCalledWith("s1", "Golden ratio");
  });

  it("calls onClear after confirming Clear all", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: /Clear all/ }));
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });
});
