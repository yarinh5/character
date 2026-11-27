export type ConsentRequirement = {
  id: string;
  consent_key: string;
  version: string;
  title: string;
  document_url: string;
  required: boolean;
  accepted_at: string | null;
};

export function parseConsentRequirements(value: unknown): ConsentRequirement[] {
  if (!Array.isArray(value)) throw new Error("consent_requirements_malformed");
  return value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !("consent_key" in item) ||
      typeof item.consent_key !== "string" ||
      !("version" in item) ||
      typeof item.version !== "string" ||
      !("title" in item) ||
      typeof item.title !== "string" ||
      !("document_url" in item) ||
      typeof item.document_url !== "string" ||
      !("required" in item) ||
      typeof item.required !== "boolean" ||
      !("accepted_at" in item) ||
      (item.accepted_at !== null && typeof item.accepted_at !== "string")
    ) {
      throw new Error("consent_requirements_malformed");
    }
    return item as ConsentRequirement;
  });
}
