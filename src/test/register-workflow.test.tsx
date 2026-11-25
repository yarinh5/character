import type { ComponentType, ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  register: vi.fn(),
  navigate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.stubGlobal(
  "ResizeObserver",
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => io.navigate,
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: () => io.register }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: null, role: null, loading: false }),
  rolePath: () => "/",
}));
vi.mock("@/lib/registration.functions", () => ({
  registerClient: {},
  RegistrationFailure: class RegistrationFailure extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));

import { Route } from "@/routes/register";

const RegisterPage = (Route as unknown as { component: ComponentType }).component;

function fillFields() {
  fireEvent.change(screen.getByLabelText("שם תצוגה"), { target: { value: "לקוחה חדשה" } });
  fireEvent.change(screen.getByLabelText("אימייל"), { target: { value: "client@example.com" } });
  fireEvent.change(screen.getByLabelText("סיסמה"), { target: { value: "correct-horse-battery" } });
}

function completeForm() {
  fillFields();
  const checkboxes = screen.getAllByRole("checkbox");
  fireEvent.click(checkboxes[0]);
  fireEvent.click(checkboxes[1]);
}

describe("consent accessibility", () => {
  it("exposes the existing registration title as the only level-one heading", () => {
    render(<RegisterPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "צור חשבון" }).tagName).toBe("H1");
  });

  it.each([
    { missing: "terms", termsMissing: true, ageMissing: false },
    { missing: "age", termsMissing: false, ageMissing: true },
    { missing: "both", termsMissing: true, ageMissing: true },
  ])("identifies and focuses missing declarations: $missing", ({ termsMissing, ageMissing }) => {
    render(<RegisterPage />);
    fillFields();
    const terms = screen.getByRole("checkbox", { name: /מדיניות הפרטיות/ });
    const age = screen.getByRole("checkbox", { name: /18 ומעלה/ });
    const submit = screen.getByRole("button", { name: "צור חשבון" });
    if (!termsMissing) fireEvent.click(terms);
    if (!ageMissing) fireEvent.click(age);
    submit.focus();
    fireEvent.click(submit);
    expect(termsMissing ? terms : age).toHaveFocus();

    for (const [box, missing, subject] of [
      [terms, termsMissing, /תנאי השימוש.*מדיניות הפרטיות/],
      [age, ageMissing, /18 ומעלה/],
    ] as const) {
      expect(box).toBeRequired();
      if (missing) {
        expect(box).toHaveAttribute("aria-invalid", "true");
        expect(box).toHaveAccessibleDescription(subject);
      } else {
        expect(box).not.toHaveAttribute("aria-invalid", "true");
        expect(box).not.toHaveAccessibleDescription();
      }
    }
    if (termsMissing) {
      fireEvent.click(terms);
      expect(terms).not.toHaveAttribute("aria-invalid", "true");
      expect(terms).not.toHaveAccessibleDescription();
    }
    if (ageMissing) {
      expect(age).toHaveAccessibleDescription(/18 ומעלה/);
      submit.focus();
      fireEvent.click(submit);
      expect(age).toHaveFocus();
      fireEvent.click(age);
      expect(age).not.toHaveAttribute("aria-invalid", "true");
      expect(age).not.toHaveAccessibleDescription();
    }
    expect(io.register).not.toHaveBeenCalled();
    expect(io.success).not.toHaveBeenCalled();
  });
});

describe("registration workflow", () => {
  beforeEach(() => {
    io.register.mockReset();
    io.navigate.mockReset();
    io.success.mockReset();
    io.error.mockReset();
  });

  it("shows verification pending only after the server path succeeds", async () => {
    io.register.mockResolvedValue({ status: "verification_pending" });
    render(<RegisterPage />);
    completeForm();
    fireEvent.click(screen.getByRole("button", { name: "צור חשבון" }));

    await waitFor(() =>
      expect(io.success).toHaveBeenCalledWith(expect.stringContaining("בדוק את האימייל")),
    );
    expect(io.register).toHaveBeenCalledTimes(1);
  });

  it("does not report activation or a bonus when admission is paused", async () => {
    io.register.mockRejectedValue(
      Object.assign(new Error("paused"), { code: "registration_paused" }),
    );
    render(<RegisterPage />);
    completeForm();
    fireEvent.click(screen.getByRole("button", { name: "צור חשבון" }));

    await waitFor(() => expect(io.error).toHaveBeenCalled());
    expect(io.success).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "צור חשבון" })).toBeEnabled();
  });

  it("blocks a duplicate submit while pending and permits an explicit retry after failure", async () => {
    let rejectFirst: ((reason: unknown) => void) | undefined;
    io.register
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({ status: "verification_pending" });
    render(<RegisterPage />);
    completeForm();
    const submit = screen.getByRole("button", { name: "צור חשבון" });
    fireEvent.click(submit);
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(io.register).toHaveBeenCalledTimes(1);

    rejectFirst?.(new Error("transport"));
    await waitFor(() => expect(screen.getByRole("button", { name: "צור חשבון" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "צור חשבון" }));
    await waitFor(() => expect(io.register).toHaveBeenCalledTimes(2));
  });
});
