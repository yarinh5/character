import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartHandshake, RefreshCw } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type CharacterLead = {
  id: string;
  client_id: string;
  client_name: string;
  character_id: string;
  character_name: string;
  source: string;
  status: "new" | "in_progress" | "closed";
  interest_active: boolean;
  created_at: string;
  last_liked_at: string;
  updated_at: string;
};

type LeadStatus = CharacterLead["status"];

function isCharacterLead(value: unknown): value is CharacterLead {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.client_id === "string" &&
    typeof row.client_name === "string" &&
    typeof row.character_id === "string" &&
    typeof row.character_name === "string" &&
    row.source === "discovery_like" &&
    (row.status === "new" || row.status === "in_progress" || row.status === "closed") &&
    typeof row.interest_active === "boolean" &&
    typeof row.created_at === "string" &&
    typeof row.last_liked_at === "string" &&
    typeof row.updated_at === "string"
  );
}

function isLeadStatusResult(
  value: unknown,
): value is Pick<CharacterLead, "id" | "status" | "interest_active" | "updated_at"> {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    (row.status === "new" || row.status === "in_progress" || row.status === "closed") &&
    typeof row.interest_active === "boolean" &&
    typeof row.updated_at === "string"
  );
}

async function readCharacterLeads() {
  const { data, error } = await supabase.rpc("get_character_leads", { _limit: 100 });
  if (error) throw error;
  if (!Array.isArray(data) || !data.every(isCharacterLead)) {
    throw new Error("invalid_character_leads_response");
  }
  return data;
}

export function LeadWorkspace({ identityKey }: { identityKey: string }) {
  const queryClient = useQueryClient();
  const statusWriteInFlight = useRef(false);
  const leads = useQuery({
    queryKey: ["character-leads", identityKey],
    queryFn: readCharacterLeads,
  });
  const updateStatus = useMutation({
    mutationFn: async ({ leadId, status }: { leadId: string; status: LeadStatus }) => {
      const { data, error } = await supabase.rpc("update_character_lead_status", {
        _lead_id: leadId,
        _status: status,
      });
      const result = Array.isArray(data) ? data[0] : null;
      if (
        error ||
        !isLeadStatusResult(result) ||
        result.id !== leadId ||
        result.status !== status
      ) {
        throw new Error("lead_status_update_failed");
      }
      return result;
    },
    onSuccess: (result) => {
      queryClient.setQueryData<CharacterLead[]>(["character-leads", identityKey], (current) =>
        current?.map((lead) => (lead.id === result.id ? { ...lead, ...result } : lead)),
      );
      toast.success("סטטוס ה־Lead עודכן");
    },
    onError: () => toast.error("עדכון ה־Lead נכשל. אפשר לנסות שוב."),
  });
  const submitStatus = (leadId: string, status: LeadStatus) => {
    if (statusWriteInFlight.current) return;
    statusWriteInFlight.current = true;
    updateStatus.mutate(
      { leadId, status },
      { onSettled: () => (statusWriteInFlight.current = false) },
    );
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8" dir="rtl">
      <header>
        <h1 className="text-2xl font-bold">Leads מדמויות</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          עניין שנוצר מ־Like. הרשומה אינה הודעה, שיחת NEW או הרשאת שליחה.
        </p>
      </header>

      {leads.isLoading && (
        <div className="space-y-3" role="status" aria-label="טוען Leads">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {leads.isError && (
        <div className="rounded-lg border border-destructive/40 p-6 text-center" role="alert">
          <p className="text-sm text-destructive">טעינת ה־Leads נכשלה.</p>
          <Button
            className="mt-4 gap-2"
            variant="outline"
            onClick={() => void leads.refetch()}
            disabled={leads.isFetching}
          >
            <RefreshCw className={leads.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            נסה שוב
          </Button>
        </div>
      )}

      {leads.isSuccess && leads.data.length === 0 && (
        <div className="rounded-lg border p-8 text-center text-muted-foreground">
          <HeartHandshake className="mx-auto mb-3 h-10 w-10" />
          <p>אין Leads מורשים להצגה כרגע.</p>
        </div>
      )}

      {leads.data && leads.data.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2" aria-busy={leads.isFetching}>
          {leads.data.map((lead) => (
            <Card key={lead.id}>
              <CardContent className="space-y-2 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{lead.client_name}</p>
                    <p className="text-sm text-muted-foreground">
                      התעניין/ה ב־{lead.character_name}
                    </p>
                  </div>
                  <HeartHandshake className="h-5 w-5 text-rose-600" aria-hidden="true" />
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(lead.last_liked_at).toLocaleString("he-IL")}
                </p>
                <p className="text-xs font-medium">
                  {lead.status === "new"
                    ? "חדש"
                    : lead.status === "in_progress"
                      ? "בטיפול"
                      : lead.interest_active
                        ? "נסגר"
                        : "העניין בוטל"}
                </p>
                <div
                  className="flex flex-wrap gap-2"
                  aria-label={`פעולות Lead עבור ${lead.client_name}`}
                >
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      updateStatus.isPending ||
                      !lead.interest_active ||
                      lead.status === "in_progress"
                    }
                    onClick={() => submitStatus(lead.id, "in_progress")}
                  >
                    סמן בטיפול
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={updateStatus.isPending || lead.status === "closed"}
                    onClick={() => submitStatus(lead.id, "closed")}
                  >
                    סגור
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
