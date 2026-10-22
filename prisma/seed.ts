/**
 * Idempotent seed for Real-Time Call Trainer.
 *
 * Creates (or updates) a platform-admin user from environment variables.
 * Run with:
 *    npm run db:seed
 *
 * Required env (one-time only):
 *   ADMIN_EMAIL, ADMIN_PASSWORD
 *
 * Optional:
 *   ADMIN_FIRST_NAME, ADMIN_LAST_NAME
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL?.toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.log(
      "[seed] ADMIN_EMAIL and ADMIN_PASSWORD not set — skipping platform-admin seed.",
    );
    return;
  }
  if (password.length < 10) {
    throw new Error("ADMIN_PASSWORD must be at least 10 characters.");
  }

  const firstName = process.env.ADMIN_FIRST_NAME ?? "Platform";
  const lastName = process.env.ADMIN_LAST_NAME ?? "Admin";

  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.user.upsert({
    where: { email },
    update: {
      passwordHash,
      firstName,
      lastName,
      isPlatformAdmin: true,
    },
    create: {
      email,
      passwordHash,
      firstName,
      lastName,
      isPlatformAdmin: true,
      role: "owner",
    },
  });

  console.log(
    `[seed] Platform admin upserted: ${admin.email} (id=${admin.id}).`,
  );
}

main()
  .catch((e) => {
    console.error("[seed] error", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
