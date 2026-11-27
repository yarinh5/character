import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Product Completion and WP01.5 read-access integration candidate", () => {
  it("preserves the final attachment result shape behind the WP01.5 authorization gate", () => {
    const migration = read(
      "integration/candidate-migrations/product_completion_read_access_gate.sql",
    );

    expect(migration).toContain("private.can_user_read_conversation(message.conversation_id");
    expect(migration).toContain("private.can_user_read_conversation(_conversation_id");
    expect(migration).toContain("get_message_attachment_access_before_product_read_access_gate");
    expect(migration).toContain("resolve_message_attachment_media_before_product_read_access_gate");
    for (const field of [
      "view_mode TEXT",
      "session_expires_at TIMESTAMPTZ",
      "required_gift_id UUID",
      "required_gift_name TEXT",
      "required_gift_price_credits INTEGER",
      "available_purchase_id UUID",
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.get_message_attachment_access_before_product_read_access_gate",
    );
  });

  it("keeps both the Product fields and WP01.5 generation contract in client types", () => {
    const hook = read("src/hooks/useMessageAttachmentAccessMap.ts");
    const types = read("src/integrations/supabase/types.ts");

    for (const field of [
      "required_gift_id",
      "required_gift_name",
      "required_gift_price_credits",
      "available_purchase_id",
    ]) {
      expect(hook).toContain(field);
      expect(types).toContain(field);
    }
    expect(hook).toContain("accessGenerationRef");
    expect(types).toContain("user_conversation_access_versions");
    expect(types).toContain("get_conversation_read_access");
  });
});
