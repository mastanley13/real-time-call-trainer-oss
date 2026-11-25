import { execSync } from "node:child_process";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

run("npx prisma generate");

if (process.env.VERCEL_ENV === "production" && process.env.DATABASE_URL) {
  console.log("[vercel-build] Production deploy detected; applying pending Prisma migrations...");
  run("npx prisma migrate deploy");
} else {
  console.log("[vercel-build] Skipping prisma migrate deploy (not a production deploy with DATABASE_URL).");
}

run("npx next build");
