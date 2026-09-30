import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

function OpenDialog() {
  const [open, setOpen] = useState(true);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent>
        <DialogTitle>חלון בדיקה</DialogTitle>
        <DialogDescription>תוכן בדיקה</DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("exposes a Hebrew close label and closes through the control", async () => {
    const user = userEvent.setup();
    render(<OpenDialog />);

    const closeButton = screen.getByRole("button", { name: "סגור" });
    expect(closeButton).toBeInTheDocument();

    await user.click(closeButton);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
