import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProfileImageManager } from "@/components/profile/ProfileImageManager";

const upload = vi.hoisted(() => ({ onChange: null as ((url: string | null) => void) | null }));
vi.mock("@/components/common/AvatarUpload", () => ({
  AvatarUpload: ({
    onChange,
    disabled,
  }: {
    onChange: (url: string | null) => void;
    disabled?: boolean;
  }) => {
    upload.onChange = onChange;
    return (
      <button type="button" disabled={disabled} onClick={() => onChange("new.webp")}>
        העלאה מדומה
      </button>
    );
  },
}));

describe("ProfileImageManager", () => {
  it("adds up to six images and never adds beyond the limit", () => {
    const onChange = vi.fn();
    const images = ["1.webp", "2.webp", "3.webp", "4.webp", "5.webp"];
    const view = render(
      <ProfileImageManager
        userId="client-a"
        images={images}
        primary="1.webp"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "העלאה מדומה" }));
    expect(onChange).toHaveBeenLastCalledWith([...images, "new.webp"], "1.webp");

    view.rerender(
      <ProfileImageManager
        userId="client-a"
        images={[...images, "6.webp"]}
        primary="1.webp"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("button", { name: "העלאה מדומה" })).toBeDisabled();
  });

  it("keeps legacy images while allowing reorder and removal without adding", () => {
    const onChange = vi.fn();
    const images = Array.from({ length: 7 }, (_, index) => `${index + 1}.webp`);
    render(
      <ProfileImageManager
        userId="client-a"
        images={images}
        primary="1.webp"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("פרופיל legacy");
    expect(screen.getByRole("button", { name: "העלאה מדומה" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "הזז תמונה 2 למעלה" }));
    expect(onChange).toHaveBeenCalledWith(
      ["2.webp", "1.webp", "3.webp", "4.webp", "5.webp", "6.webp", "7.webp"],
      "1.webp",
    );
    fireEvent.click(screen.getByRole("button", { name: "הסר תמונה 7" }));
    expect(onChange).toHaveBeenCalledWith(images.slice(0, 6), "1.webp");
  });

  it("selects the next ordered image when the primary is removed", () => {
    const onChange = vi.fn();
    render(
      <ProfileImageManager
        userId="client-a"
        images={["first.webp", "primary.webp", "next.webp"]}
        primary="primary.webp"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "הסר תמונה 2" }));
    expect(onChange).toHaveBeenCalledWith(["first.webp", "next.webp"], "next.webp");
  });

  it("supports explicit primary selection and keyboard-operable ordering buttons", () => {
    const onChange = vi.fn();
    render(
      <ProfileImageManager
        userId="client-a"
        images={["first.webp", "second.webp"]}
        primary="first.webp"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "הגדר תמונה 2 כראשית" }));
    expect(onChange).toHaveBeenCalledWith(["first.webp", "second.webp"], "second.webp");
    expect(screen.getByRole("button", { name: "הזז תמונה 2 למעלה" })).toHaveAttribute(
      "type",
      "button",
    );
  });
});
