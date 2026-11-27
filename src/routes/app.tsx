import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ClientLayout, RequireClient } from "@/components/client/ClientLayout";
import { RecoveryAccessGate } from "@/components/recovery/RecoveryAccessGate";

export const Route = createFileRoute("/app")({
  component: () => (
    <RecoveryAccessGate>
      <RequireClient>
        <ClientLayout>
          <Outlet />
        </ClientLayout>
      </RequireClient>
    </RecoveryAccessGate>
  ),
});
