import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ClientLayout, RequireClient } from "@/components/client/ClientLayout";

export const Route = createFileRoute("/app")({
  component: () => (
    <RequireClient>
      <ClientLayout>
        <Outlet />
      </ClientLayout>
    </RequireClient>
  ),
});
