import { z } from "zod";

/**
 * Password rules shared by sign-up and password reset. They mirror RegisterSchema.password in
 * src/app/api/auth/register/route.ts (tests/password-reset-route.test.ts checks the two stay in step).
 * Client-safe: no secrets, no Node imports.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
export const PASSWORD_MIN_MESSAGE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE)
  .max(PASSWORD_MAX_LENGTH);
