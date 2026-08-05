# Contributing

This is a portfolio repository. It is not actively accepting external contributions.

If you find a security issue, please see `SECURITY.md`.

If you are building something similar and have questions about the architecture, feel free to open an issue.

## Local development

See the [README](README.md) for setup instructions.

## Code style

- TypeScript strict mode on the frontend; `strictNullChecks: false` on the server (historical; new code should handle nulls explicitly)
- Pino for structured logging on the server — never `console.*`
- Express route handlers follow the pattern in `docs/ARCHITECTURE.md`
- Vercel Workflow functions use `step.run()` for all async work to get retryability
