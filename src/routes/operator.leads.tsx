import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { useOperator } from "@/components/operator/OperatorLayout";
import { LeadWorkspace } from "@/components/leads/LeadWorkspace";

export const Route = createFileRoute("/operator/leads")({ component: OperatorLeadsPage });

function OperatorLeadsPage() {
  const { loading, role, session } = useAuth();
  const { operator } = useOperator();
  const operatorId =
    !loading && role === "operator" && session?.user.id === operator?.user_id
      ? (operator?.id ?? null)
      : null;
  return operatorId ? (
    <LeadWorkspace key={operatorId} identityKey={`operator:${operatorId}`} />
  ) : null;
}
