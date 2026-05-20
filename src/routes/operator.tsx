import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RequireOperator } from "@/components/operator/OperatorLayout";

export const Route = createFileRoute("/operator")({
  component: () => (
    <RequireOperator>
      <Outlet />
    </RequireOperator>
  ),
});
