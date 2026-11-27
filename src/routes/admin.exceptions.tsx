import { createFileRoute, Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin/exceptions")({ component: ExceptionsPage });

const PAGE_SIZE = 100;
const labels = {
  allocation: "שיוך והקצאה",
  gift_failed: "חלוקת Gift נכשלה",
  gift_unallocated: "Gift ללא זכאים",
  media_cleanup: "ניקוי מדיה נכשל",
  account_deletion_blocked: "מחיקת חשבון חסומה",
  account_deletion_failed: "מחיקת חשבון נכשלה",
  conversation_deletion_blocked: "מחיקת שיחה חסומה",
  conversation_deletion_failed: "מחיקת שיחה נכשלה",
} as const;
type ExceptionKind = keyof typeof labels;
type Cursor = { occurred_at: string; kind: string; id: string } | null;

function ExceptionsPage() {
  const { session, user, role, loading } = useAuth();
  const adminId = !loading && role === "admin" && session?.user.id === user?.id ? user?.id : null;
  return adminId ? (
    <ExceptionsWorkspace key={adminId} adminId={adminId} />
  ) : (
    <p role="status">נדרש חיבור מנהל מאומת.</p>
  );
}

function ExceptionsWorkspace({ adminId }: { adminId: string }) {
  const [kind, setKind] = useState<ExceptionKind | "all">("all");
  const query = useInfiniteQuery({
    queryKey: ["admin-completion-exception-cases", adminId, kind],
    initialPageParam: null as Cursor,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await supabase.rpc("get_admin_completion_exception_cases", {
        _kind: kind === "all" ? null : kind,
        _before_occurred_at: pageParam?.occurred_at ?? null,
        _before_kind: pageParam?.kind ?? null,
        _before_id: pageParam?.id ?? null,
        _page_size: PAGE_SIZE + 1,
      });
      if (error) throw error;
      if (!Array.isArray(data) || data.length > PAGE_SIZE + 1) {
        throw new Error("invalid_exception_cases_result");
      }
      for (const item of data) {
        if (
          !item ||
          typeof item !== "object" ||
          !(item.kind in labels) ||
          typeof item.id !== "string" ||
          typeof item.occurred_at !== "string" ||
          (item.code !== null && typeof item.code !== "string") ||
          (item.subject_id !== null && typeof item.subject_id !== "string")
        ) {
          throw new Error("invalid_exception_cases_result");
        }
      }
      return data;
    },
    getNextPageParam: (page) =>
      page.length > PAGE_SIZE
        ? {
            occurred_at: page[PAGE_SIZE - 1].occurred_at,
            kind: page[PAGE_SIZE - 1].kind,
            id: page[PAGE_SIZE - 1].id,
          }
        : undefined,
  });
  const cases = query.data?.pages.flatMap((page) => page.slice(0, PAGE_SIZE)) ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-8" dir="rtl">
      <PageHeader title="חריגים תפעוליים" description="מקרים פתוחים לפי מקור" />
      <div className="flex flex-wrap items-end gap-3">
        <Select
          dir="rtl"
          value={kind}
          onValueChange={(value) => {
            if (value === "all" || value in labels) setKind(value as ExceptionKind | "all");
          }}
        >
          <SelectTrigger aria-label="סוג חריג" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">כל החריגים</SelectItem>
            {Object.entries(labels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
          רענון
        </Button>
      </div>
      {query.isPending && (
        <div role="status" aria-label="טוען חריגים" className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      )}
      {query.isError && !query.isFetchNextPageError && (
        <p role="alert">
          {query.data === undefined
            ? "טעינת החריגים נכשלה."
            : "רענון החריגים נכשל. המקרים שכבר נטענו נשמרו."}
        </p>
      )}
      {query.isFetchNextPageError && (
        <p role="alert">טעינת מקרים נוספים נכשלה. המקרים שכבר נטענו נשמרו.</p>
      )}
      {query.data !== undefined && (
        <>
          <p className="text-sm text-muted-foreground">
            {cases.length} מקרים שנטענו{query.hasNextPage ? "; קיימים מקרים נוספים" : ""}
          </p>
          {!cases.length ? (
            <p>אין חריגים פתוחים במסנן הנוכחי.</p>
          ) : (
            <div className="divide-y border-y">
              {cases.map((item) => (
                <article key={`${item.kind}:${item.id}`} className="space-y-2 py-4 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="font-medium">{labels[item.kind as ExceptionKind]}</h2>
                    <time className="text-muted-foreground" dateTime={item.occurred_at}>
                      {new Date(item.occurred_at).toLocaleString("he-IL")}
                    </time>
                  </div>
                  <p>
                    מזהה מקרה:{" "}
                    <code dir="ltr" className="break-all">
                      {item.id}
                    </code>
                  </p>
                  {item.code && <p>קוד: {item.code}</p>}
                  {item.subject_id && (
                    <p>
                      {item.kind.startsWith("account_deletion") ? "משתמש" : "שיחה"}:{" "}
                      <code dir="ltr" className="break-all">
                        {item.subject_id}
                      </code>
                    </p>
                  )}
                  {item.subject_id && !item.kind.startsWith("account_deletion") && (
                    <Link
                      to="/admin/conversations/$conversationId"
                      params={{ conversationId: item.subject_id }}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      לשיחה
                    </Link>
                  )}
                </article>
              ))}
            </div>
          )}
          {query.hasNextPage && (
            <Button
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? "טוען עוד מקרים…" : "טען עוד מקרים"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
