import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type RegistrationFailureCode =
  | "eligibility_declaration_required"
  | "registration_paused"
  | "registration_rate_limited"
  | "registration_unavailable"
  | "already_registered"
  | "auth_failed";

export class RegistrationFailure extends Error {
  constructor(
    public readonly code: RegistrationFailureCode,
    message = code,
  ) {
    super(message);
    this.name = "RegistrationFailure";
  }
}

const registrationSchema = z.object({
  displayName: z.string().trim().min(2).max(50),
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(72),
  ageConfirmed: z.literal(true),
  termsAccepted: z.literal(true),
});

type RegistrationRequest = z.infer<typeof registrationSchema>;
type AdmissionResult =
  | { allowed: true; admissionToken: string; expiresAt: string }
  | {
      allowed: false;
      reason: "registration_paused" | "registration_rate_limited" | "registration_unavailable";
    };

type RegistrationDependencies = {
  issueAdmission(input: {
    email: string;
    ageConfirmed: true;
    termsAccepted: true;
  }): Promise<AdmissionResult>;
  signUp(input: {
    email: string;
    password: string;
    redirectUrl: string;
    metadata: { display_name: string; registration_admission_token: string };
  }): Promise<{ userId: string | null }>;
};

export async function registerClientWithDependencies(
  rawRequest: unknown,
  dependencies: RegistrationDependencies,
  configuration: { emailVerificationRedirectUrl: string } | null = resolveRegistrationConfiguration(
    process.env,
  ),
) {
  const parsed = registrationSchema.safeParse(rawRequest);
  if (!parsed.success) {
    throw new RegistrationFailure("eligibility_declaration_required");
  }
  if (!configuration) {
    throw new RegistrationFailure("registration_unavailable");
  }

  const request = parsed.data;
  const email = request.email.toLowerCase();
  const admission = await dependencies.issueAdmission({
    email,
    ageConfirmed: request.ageConfirmed,
    termsAccepted: request.termsAccepted,
  });
  if (!admission.allowed) {
    throw new RegistrationFailure(admission.reason);
  }
  await dependencies.signUp({
    email,
    password: request.password,
    redirectUrl: configuration.emailVerificationRedirectUrl,
    metadata: {
      display_name: request.displayName,
      registration_admission_token: admission.admissionToken,
    },
  });

  return { status: "verification_pending" as const };
}

export function resolveRegistrationConfiguration(
  environment: Record<string, string | undefined>,
): { emailVerificationRedirectUrl: string } | null {
  const configured = environment.AUTH_EMAIL_VERIFICATION_REDIRECT_URL?.trim();
  const allowedOrigins = new Set(
    (environment.AUTH_REDIRECT_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!configured || allowedOrigins.size === 0) return null;
  try {
    const target = new URL(configured);
    if (!['http:', 'https:'].includes(target.protocol) || !allowedOrigins.has(target.origin)) {
      return null;
    }
    return { emailVerificationRedirectUrl: target.toString() };
  } catch {
    return null;
  }
}

function getPublicAuthClient() {
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) throw new RegistrationFailure("registration_unavailable");
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
}

export const registerClient = createServerFn({ method: "POST" })
  .inputValidator((input) => registrationSchema.parse(input))
  .handler(async ({ data }) =>
    registerClientWithDependencies(data, {
      async issueAdmission(input) {
        const { data: result, error } = await supabaseAdmin.rpc(
          "create_registration_admission_for_server",
          {
            _email: input.email,
            _age_confirmed: input.ageConfirmed,
            _terms_accepted: input.termsAccepted,
          },
        );
        if (error || !result || typeof result !== "object" || Array.isArray(result)) {
          throw new RegistrationFailure("registration_unavailable");
        }
        const record = result as Record<string, unknown>;
        if (record.allowed !== true) {
          const reason = record.reason;
          if (reason === "registration_paused" || reason === "registration_rate_limited") {
            return { allowed: false, reason };
          }
          return { allowed: false, reason: "registration_unavailable" };
        }
        if (typeof record.admission_token !== "string" || typeof record.expires_at !== "string") {
          throw new RegistrationFailure("registration_unavailable");
        }
        return {
          allowed: true,
          admissionToken: record.admission_token,
          expiresAt: record.expires_at,
        };
      },
      async signUp(input) {
        const { data: result, error } = await getPublicAuthClient().auth.signUp({
          email: input.email,
          password: input.password,
          options: {
            emailRedirectTo: input.redirectUrl,
            data: input.metadata,
          },
        });
        if (error) {
          if (error.message.toLowerCase().includes("already registered")) {
            throw new RegistrationFailure("already_registered");
          }
          throw new RegistrationFailure("auth_failed");
        }
        return { userId: result.user?.id ?? null };
      },
    }, resolveRegistrationConfiguration(process.env)),
  );
