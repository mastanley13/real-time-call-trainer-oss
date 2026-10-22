# Contributing

Thanks for helping improve Real-Time Call Trainer.

## Setup
```bash
npm install
cp .env.example .env     # DEMO_MODE=true lets you run with no DB or API keys
npm run dev
```

## Before opening a PR
- `npx tsc --noEmit` and `npm run lint` pass.
- `npm run build` succeeds (set a dummy `DATABASE_URL` if needed for `prisma generate`).
- Walk the relevant flow in [TESTING.md](TESTING.md).
- Never commit secrets. `.env*` files other than `.env.example` are git-ignored.

## Guidelines
- Keep PRs focused; describe the user-visible change.
- New scenarios belong in `src/lib/scenarios.ts` (`BUILT_IN_SCENARIOS`) and need a rubric whose criteria have clear, observable descriptions.
- Server routes must validate input with zod and call `requireAuth`.
- Schema changes need a Prisma migration (`npx prisma migrate dev --name <change>`).

By contributing you agree your work is released under the MIT license.
