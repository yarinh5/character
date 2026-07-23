import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LoaderCircle, MessageCircle, RefreshCw, Search, Send, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useOperator } from "@/components/operator/OperatorLayout";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { type OperatorOnlineCandidate, useOperatorOnlineCandidates } from "@/hooks/useOperatorOnlineCandidates";
import { operatorOutreachErrorMessage, useOperatorOutreachSend } from "@/hooks/useOperatorOutreachSend";

export const Route = createFileRoute("/operator/online")({
  component: OperatorOnlinePage,
});

const COOLDOWN_MESSAGE = "כבר נשלחה פנייה ללקוח הזה בשם הדמות שנבחרה. אפשר לנסות שוב בעוד 24 שעות.";

function candidateInitials(name: string) {
  return name.trim().slice(0, 2) || "לק";
}

function OperatorOnlinePage() {
  const { operator } = useOperator();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<OperatorOnlineCandidate | null>(null);
  const [selectedCharacterId, setSelectedCharacterId] = useState("");
  const [message, setMessage] = useState("");
  const [cooldownTargets, setCooldownTargets] = useState(() => new Set<string>());

  const candidates = useOperatorOnlineCandidates({ search, characterId });
  const outreach = useOperatorOutreachSend();

  const characters = useMemo(() => {
    const options = new Map<string, string>();
    for (const candidate of candidates.data ?? []) {
      for (const option of candidate.character_options) options.set(option.character_id, option.character_name);
    }
    return [...options.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "he"));
  }, [candidates.data]);

  const selectedCharacter = selectedCandidate?.character_options.find((option) => option.character_id === selectedCharacterId) ?? null;
  const selectedTarget = selectedCandidate && selectedCharacter ? `${selectedCandidate.client_id}:${selectedCharacter.character_id}` : null;
  const isCoolingDown = Boolean(selectedTarget && cooldownTargets.has(selectedTarget));
  const isSending = Boolean(selectedTarget && outreach.sendingTarget === selectedTarget);

  const openComposer = (candidate: OperatorOnlineCandidate) => {
    setSelectedCandidate(candidate);
    setSelectedCharacterId(candidate.character_options[0]?.character_id ?? "");
    setMessage("");
  };

  const closeComposer = () => {
    if (isSending) return;
    setSelectedCandidate(null);
    setSelectedCharacterId("");
    setMessage("");
  };

  const sendOutreach = async () => {
    if (!selectedCandidate || !selectedCharacter || !message.trim() || isCoolingDown) return;

    const { result, errorCode } = await outreach.send({
      clientId: selectedCandidate.client_id,
      characterId: selectedCharacter.character_id,
      message,
    });

    if (errorCode) {
      if (errorCode.includes("outreach_rate_limited")) {
        setCooldownTargets((current) => new Set(current).add(`${selectedCandidate.client_id}:${selectedCharacter.character_id}`));
      }
      toast.error(operatorOutreachErrorMessage(errorCode));
      return;
    }

    closeComposer();
    toast.success("הפנייה נשלחה.", result?.conversation_id ? {
      action: {
        label: "פתח שיחה",
        onClick: () => navigate({ to: "/operator/chat/$conversationId", params: { conversationId: result.conversation_id! } }),
      },
    } : undefined);
  };

  if (!operator) {
    return <div className="p-6 text-muted-foreground" dir="rtl">נדרש חשבון עובד פעיל כדי לצפות בלקוחות זמינים.</div>;
  }

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8" dir="rtl">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">ONLINE</h1>
          <p className="mt-1 text-sm text-muted-foreground">לקוחות הזמינים לפנייה בשם דמות המשויכת אליך.</p>
        </div>
        <Button variant="outline" size="icon" onClick={() => void candidates.refetch()} disabled={candidates.isFetching} aria-label="רענון לקוחות" title="רענון">
          <RefreshCw className={candidates.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </Button>
      </header>

      <div className="mb-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
        <div className="relative">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="חיפוש לפי שם" className="pr-9" />
        </div>
        <Select value={characterId ?? "all"} onValueChange={(value) => setCharacterId(value === "all" ? null : value)}>
          <SelectTrigger aria-label="סינון לפי דמות"><SelectValue placeholder="כל הדמויות" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">כל הדמויות</SelectItem>
            {characters.map((character) => <SelectItem key={character.id} value={character.id}>{character.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {candidates.isLoading ? (
        <div className="flex min-h-48 items-center justify-center text-muted-foreground"><LoaderCircle className="ml-2 h-5 w-5 animate-spin" />טוען לקוחות זמינים</div>
      ) : candidates.error ? (
        <Card><CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center"><p>לא ניתן לטעון לקוחות זמינים כרגע.</p><Button variant="outline" onClick={() => void candidates.refetch()}>נסה שוב</Button></CardContent></Card>
      ) : candidates.data?.length === 0 ? (
        <Card><CardContent className="flex min-h-48 flex-col items-center justify-center gap-2 p-6 text-center"><UserRound className="h-8 w-8 text-muted-foreground" /><p className="font-medium">אין לקוחות זמינים לפנייה כרגע</p><p className="text-sm text-muted-foreground">לקוחות שיוכלו לקבל פנייה יופיעו כאן.</p></CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {candidates.data?.map((candidate) => (
            <Card key={candidate.client_id} className="flex min-h-44 flex-col">
              <CardContent className="flex flex-1 flex-col p-4">
                <div className="flex items-center gap-3">
                  <Avatar className="h-10 w-10"><AvatarImage src={candidate.avatar_url ?? undefined} alt="" /><AvatarFallback>{candidateInitials(candidate.display_name)}</AvatarFallback></Avatar>
                  <div className="min-w-0 flex-1"><p className="truncate font-semibold">{candidate.display_name}</p><p className="text-xs text-muted-foreground">{candidate.has_existing_conversation ? "קיימת שיחה פתוחה" : "פנייה חדשה"}</p></div>
                </div>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {candidate.character_options.map((option) => <Badge key={option.character_id} variant="secondary">{option.character_name}</Badge>)}
                </div>
                <Button className="mt-auto w-full" onClick={() => openComposer(candidate)}><Send className="ml-2 h-4 w-4" />שלח פנייה</Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={Boolean(selectedCandidate)} onOpenChange={(open) => !open && closeComposer()}>
        <DialogContent dir="rtl" className="sm:max-w-lg">
          <DialogHeader><DialogTitle>פנייה יזומה</DialogTitle><DialogDescription>{selectedCandidate ? `שליחת הודעה ל־${selectedCandidate.display_name} בשם דמות שלך.` : ""}</DialogDescription></DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2"><Label htmlFor="outreach-character">דמות</Label>
              <Select value={selectedCharacterId} onValueChange={setSelectedCharacterId} disabled={isSending}>
                <SelectTrigger id="outreach-character"><SelectValue placeholder="בחר דמות" /></SelectTrigger><SelectContent>{selectedCandidate?.character_options.map((option) => <SelectItem key={option.character_id} value={option.character_id}>{option.character_name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-2"><Label htmlFor="outreach-message">הודעה</Label><Textarea id="outreach-message" value={message} onChange={(event) => setMessage(event.target.value)} rows={5} maxLength={2000} disabled={isSending || isCoolingDown} placeholder="כתוב הודעה קצרה ומכבדת" /><p className="text-left text-xs text-muted-foreground">{message.length}/2000</p></div>
            {isCoolingDown && <p className="text-sm text-destructive">{COOLDOWN_MESSAGE}</p>}
          </div>
          <DialogFooter><Button variant="outline" onClick={closeComposer} disabled={isSending}>ביטול</Button><Button onClick={() => void sendOutreach()} disabled={!selectedCharacter || !message.trim() || isSending || isCoolingDown}>{isSending && <LoaderCircle className="ml-2 h-4 w-4 animate-spin" />}שלח פנייה</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
