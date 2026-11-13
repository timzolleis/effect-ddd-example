# effect-ddd-example

Reference implementation of the [`effect-ddd` skill](https://github.com/timzolleis/effect-ddd): one module, `absence` (draft → active → archived), built with Effect 4 and Prisma 7. Every concept the skill names has its implementation here.

Built with that skill.

```sh
npm install
npm run verify       # prisma generate, tsc, Postgres on :55432 (docker compose), db push, vitest, SPEC.md excerpt check
npm run check:skill  # every ts/prisma block in the skill is an excerpt of this code (skill at $EFFECT_DDD_SKILL, default ~/code/effect-ddd/skills/effect-ddd)
npm run check:lib    # src/lib helpers equal timzolleis/effect-ddd at the pinned ref (scripts/registry-lib.mjs); npm run lib:install reinstalls them
```

| Path | What |
|---|---|
| `src/absence/` | the module: `domain/`, `application/`, `view/`, `infrastructure/`, `http/` |
| `src/lib/` | cross-module helpers. Those listed in `scripts/registry-lib.mjs` are installed from timzolleis/effect-ddd, never edited here; the middlewares are this repo's |
| `src/shared/`, `src/lib/auth-middleware.ts` | stand-ins for what a host already has (ids, auth, ports); faked in `test/support.ts` |
| `test/` | one file per place that owns rules |
| `SPEC.md` | archived design record; its code blocks are checked against `src/` |

`docker compose down` stops the database.
