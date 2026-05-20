import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RequireAdmin } from "@/components/admin/AdminLayout";

export const Route = createFileRoute("/admin")({
  component: () => (
    <RequireAdmin>
      <Outlet />
    </RequireAdmin>
  ),
});
