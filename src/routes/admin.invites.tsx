import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/admin/invites")({
  component: AdminInvitesRedirect,
});

function AdminInvitesRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate({ to: "/admin/operators", replace: true });
  }, [navigate]);

  return null;
}
