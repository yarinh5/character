import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/operator/online")({
  beforeLoad: () => {
    throw redirect({ to: "/operator/conversations", replace: true });
  },
});
