import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "./terms";

export const Route = createFileRoute("/service")({
  head: () => ({ meta: [{ title: "הצהרת שירות" }] }),
  component: () => <LegalPage title="הצהרת שירות" />,
});
