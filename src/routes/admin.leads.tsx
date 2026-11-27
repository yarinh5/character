import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { LeadWorkspace } from "@/components/leads/LeadWorkspace";

export const Route = createFileRoute("/admin/leads")({ component: AdminLeadsPage });

function AdminLeadsPage() {
  const { loading, role, session, user } = useAuth();
  const adminId =
    !loading && role === "admin" && session?.user.id === user?.id ? (user?.id ?? null) : null;
  return adminId ? <LeadWorkspace key={adminId} identityKey={`admin:${adminId}`} /> : null;
}
