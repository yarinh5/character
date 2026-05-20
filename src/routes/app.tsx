import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RequireClient } from "@/components/client/ClientLayout";

export const Route = createFileRoute("/app")({
  component: () => (
    <RequireClient>
      <Outlet />
    </RequireClient>
  ),
});
