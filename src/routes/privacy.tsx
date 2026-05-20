import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "./terms";

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "מדיניות פרטיות" }] }),
  component: () => <LegalPage title="מדיניות פרטיות" />,
});
