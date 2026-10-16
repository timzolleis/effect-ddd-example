# effect-ddd-example

Reference implementation of the [`effect-ddd` skill](https://github.com/timzolleis/.dotfiles/tree/main/agents/.agents/skills/effect-ddd): one module, `absence` (draft → active → archived), built with Effect 4 and Prisma 7. Every concept the skill names has its implementation here.

Built with that skill.

```sh
npm install
npm run verify       # prisma generate, tsc, Postgres on :55432 (docker compose), db push, vitest, SPEC.md excerpt check
npm run check:skill  # every ts/prisma block in the skill is an excerpt of this code (skill at ~/.agents/skills/effect-ddd)
```

| Path | What |
|---|---|
| `src/absence/` | the module: `domain/`, `application/`, `view/`, `infrastructure/`, `http/` |
| `src/lib/` | cross-module helpers: `prefixedId`, `withOptionalTag`, `dateTimeUtcFromDate`, `matchTag`, the organization middleware |
| `src/shared/`, `src/lib/auth-middleware.ts` | stand-ins for what a host already has (ids, auth, ports); faked in `test/support.ts` |
| `test/` | one file per place that owns rules |
| `SPEC.md` | archived design record; its code blocks are checked against `src/` |

`docker compose down` stops the database.
