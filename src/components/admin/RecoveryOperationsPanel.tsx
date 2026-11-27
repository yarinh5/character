import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";

export function RecoveryOperationsPanel() {
  const queryClient = useQueryClient();
  const [evidenceSource, setEvidenceSource] = useState("");
  const [evidenceHash, setEvidenceHash] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [approvalReason, setApprovalReason] = useState("");
  const state = useQuery({
    queryKey: ["admin-restore-recovery"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_restore_recovery_state");
      if (error) throw error;
      return data ?? [];
    },
  });
  const current = state.data?.[0];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin-restore-recovery"] });
  const verify = useMutation({
    mutationFn: async () => {
      if (!current) throw new Error("recovery_event_missing");
      const { error } = await supabase.rpc("admin_verify_restore_personal_data", {
        _event_id: current.event_id,
        _expected_version: current.event_version,
        _evidence_source: evidenceSource.trim(),
        _evidence_hash: evidenceHash.trim(),
        _reason: reviewReason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      await refresh();
      toast.success("בדיקת המידע האישי נשמרה לאירוע הנוכחי");
    },
    onError: () => toast.error("שמירת הבדיקה נכשלה; מצב השחזור נשאר חסום"),
  });
  const approve = useMutation({
    mutationFn: async () => {
      if (!current) throw new Error("recovery_event_missing");
      const { error } = await supabase.rpc("admin_approve_restore_recovery", {
        _event_id: current.event_id,
        _expected_version: current.event_version,
        _reason: approvalReason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      await refresh();
      toast.success("האישור נשמר; המערכת עדיין חסומה עד שחרור הנעילה החיצונית");
    },
    onError: () => toast.error("האישור נדחה; יש להשלים את כל דרישות האירוע הנוכחי"),
  });

  if (state.isLoading) return <p role="status">טוען מצב התאוששות...</p>;
  if (state.isError)
    return (
      <div role="alert">
        <p>מצב ההתאוששות אינו זמין. אין לפתוח פעילות ללא ראיה.</p>
        <Button variant="outline" onClick={() => void state.refetch()}>
          ניסיון נוסף
        </Button>
      </div>
    );
  if (!current) return <p>אין אירוע שחזור פעיל.</p>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">אירוע שחזור פעיל</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            מצב: <strong>{current.status}</strong>
          </p>
          <p>
            אירוע: <span dir="ltr">{current.event_id}</span> · גרסה {current.event_version}
          </p>
          <p>מקור snapshot: {current.source_snapshot_id}</p>
          <p>זמן snapshot: {new Date(current.source_snapshot_at).toLocaleString("he-IL")}</p>
          <p className="text-muted-foreground">
            sessions, Realtime וקישורים חתומים קיימים דורשים טיפול תפעולי נפרד; שינוי מצב DB אינו
            מבטל אותם מיד.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">חסמי פתיחה</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {state.data?.map((item) => (
            <div key={item.requirement_name ?? "event"} className="rounded border p-3 text-sm">
              <strong>{item.requirement_name ?? "מצב כללי"}</strong>:{" "}
              {item.requirement_status ?? "לא ידוע"}
              {item.reason_code && <p className="text-destructive">{item.reason_code}</p>}
              {item.evidence_recorded_at && (
                <p className="text-muted-foreground">
                  תועדה ראיה: {new Date(item.evidence_recorded_at).toLocaleString("he-IL")}
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">בדיקת מידע אישי לאחר replay</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label htmlFor="recovery-source">מקור ראיה</Label>
          <Input
            id="recovery-source"
            value={evidenceSource}
            onChange={(event) => setEvidenceSource(event.target.value)}
          />
          <Label htmlFor="recovery-hash">Hash ראיה</Label>
          <Input
            id="recovery-hash"
            dir="ltr"
            value={evidenceHash}
            onChange={(event) => setEvidenceHash(event.target.value)}
          />
          <Label htmlFor="recovery-review-reason">סיבה</Label>
          <Textarea
            id="recovery-review-reason"
            value={reviewReason}
            onChange={(event) => setReviewReason(event.target.value)}
          />
          <Button
            disabled={
              verify.isPending ||
              !evidenceSource.trim() ||
              evidenceHash.length !== 64 ||
              reviewReason.trim().length < 8
            }
            onClick={() => verify.mutate()}
          >
            שמירת אימות לאירוע הנוכחי
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">אישור פתיחה מבוקרת</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label htmlFor="recovery-approval-reason">נימוק אישור</Label>
          <Textarea
            id="recovery-approval-reason"
            value={approvalReason}
            onChange={(event) => setApprovalReason(event.target.value)}
          />
          <Button
            disabled={
              approve.isPending ||
              current.status !== "ready_for_approval" ||
              approvalReason.trim().length < 8
            }
            onClick={() => approve.mutate()}
          >
            אישור האירוע והגרסה הנוכחיים
          </Button>
          <p className="text-sm text-muted-foreground">
            אישור זה אינו משחרר את הנעילה החיצונית ואינו פותח פעילות לבדו.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
