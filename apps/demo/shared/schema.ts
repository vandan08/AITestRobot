import { z } from "zod";

/**
 * The canonical declared truth about a staff record.
 *
 * This file is Stage 1's static-extraction target. It is deliberately written as ordinary
 * zod chains — the shape a real application would have — so the extractor is solving a
 * problem real codebases actually pose. Do not refactor it into a rule table.
 *
 * Mutations never touch this file. They are applied at runtime by the server, so the
 * declared truth here and the behaving truth in the browser can be made to disagree.
 */

export const ROLES = ["admin", "manager", "clinician", "viewer"] as const;
export const STATUSES = ["active", "suspended"] as const;

export type Role = (typeof ROLES)[number];
export type Status = (typeof STATUSES)[number];

/** Minimum age, in years, for a staff record. SPEC REQ-2.9. */
export const MIN_AGE_YEARS = 18;

export const userFormSchema = z
  .object({
    fullName: z
      .string()
      .min(2, "Full name must be at least 2 characters")
      .max(60, "Full name must be 60 characters or fewer"),

    email: z
      .string()
      .min(1, "Email is required")
      .email("Enter a valid email address"),

    phone: z
      .string()
      .regex(/^[0-9]{10}$/, "Phone must be exactly 10 digits")
      .optional(),

    role: z.enum(ROLES, {
      errorMap: () => ({ message: "Select a valid role" }),
    }),

    department: z
      .string()
      .max(60, "Department must be 60 characters or fewer")
      .optional(),

    dateOfBirth: z
      .string()
      .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "Enter a date as YYYY-MM-DD")
      .optional(),

    bio: z
      .string()
      .max(500, "Bio must be 500 characters or fewer")
      .optional(),

    notificationsEnabled: z.boolean(),

    status: z.enum(STATUSES, {
      errorMap: () => ({ message: "Select a valid status" }),
    }),
  })
  .superRefine((value, ctx) => {
    // REQ-2.8 — department is mandatory for every role except viewer.
    if (value.role !== "viewer" && !value.department?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["department"],
        message: "Department is required for this role",
      });
    }

    // REQ-2.8 — viewers have no department.
    if (value.role === "viewer" && value.department?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["department"],
        message: "Viewers cannot have a department",
      });
    }

    // REQ-2.9 — date of birth must be in the past, and the person at least 18.
    if (value.dateOfBirth) {
      const dob = new Date(`${value.dateOfBirth}T00:00:00Z`);
      if (Number.isNaN(dob.getTime())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dateOfBirth"],
          message: "Enter a real date",
        });
      } else {
        const now = referenceNow();
        if (dob.getTime() >= now.getTime()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["dateOfBirth"],
            message: "Date of birth must be in the past",
          });
        } else if (ageInYears(dob, now) < MIN_AGE_YEARS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["dateOfBirth"],
            message: `Staff must be at least ${MIN_AGE_YEARS} years old`,
          });
        }
      }
    }
  });

export type UserForm = z.infer<typeof userFormSchema>;

export interface User extends UserForm {
  id: number;
}

/**
 * A frozen clock, so the age rule is deterministic across runs.
 * Overridable via DEMO_NOW for the runner; see PLAN.md § State management.
 */
export function referenceNow(): Date {
  const override =
    typeof process !== "undefined" ? process.env?.DEMO_NOW : undefined;
  return override ? new Date(override) : new Date("2026-01-01T00:00:00Z");
}

export function ageInYears(dob: Date, now: Date): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/** Empty strings from HTML inputs are absent values, not present-but-blank ones. */
export function normalizeForm(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const key of ["phone", "department", "dateOfBirth", "bio"]) {
    if (typeof out[key] === "string" && (out[key] as string).trim() === "") {
      delete out[key];
    }
  }
  return out;
}
