import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RequireOperator } from "@/components/operator/OperatorLayout";
import { RecoveryAccessGate } from "@/components/recovery/RecoveryAccessGate";

export const Route = createFileRoute("/operator")({
  component: () => (
    <RecoveryAccessGate>
      <RequireOperator>
        <Outlet />
      </RequireOperator>
    </RecoveryAccessGate>
  ),
});
