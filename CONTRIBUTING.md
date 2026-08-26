# Contributing to search100x

Thanks for your interest in contributing. Here's everything you need to get started.

## Getting Started

```bash
git clone https://github.com/AdvRahulAR/search100x.git
cd search100x
npm install
npm run build
npm test
```

Tests hit real external endpoints — transient failures (rate-limit 429/403) are expected and not your fault.

## Adding a New Search Engine

1. Create `src/adapters/<name>.ts` implementing the `Engine` interface:

```typescript
import type { Engine, RawResult } from "../core/types.js";

export const myEngine: Engine = {
  name: "myengine",
  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    // fetch, parse, return results
  },
};
```

2. Add `"myengine"` to the `SourceName` union in `src/core/types.ts`
3. Add a weight entry in `ENGINE_WEIGHTS` in `src/core/scorer.ts`
4. Add one `EngineEntry` line in `src/search.ts → buildEngines()`
5. Add a test in `tests/sources.test.js`

Nothing else changes — the scorer, container, and dedup are engine-agnostic.

## Pull Request Guidelines

- **One concern per PR.** Bug fix, new adapter, new feature — keep them separate.
- **Build must pass** — run `npm run build` before opening a PR.
- **Tests for new behaviour** — if you add an adapter, add a test.
- **No breaking changes to the public API** without a major version bump discussion first.
- Write a clear PR description: *what* changed and *why*.

## Reporting Bugs

Open an issue at https://github.com/AdvRahulAR/search100x/issues with:
- search100x version (`npm list search100x`)
- Node.js version (`node --version`)
- Minimal reproduction (query + options + error/output)

## Suggesting Features

Open an issue with the `enhancement` label. Explain the use case — a concrete scenario is more persuasive than an abstract wish.

## Code Style

- TypeScript strict mode preferred
- No default exports — named exports only
- Keep adapters thin: fetch → parse → return `RawResult[]`, nothing else
- No `console.log` in library code — use `src/core/logger.ts`

## License

By contributing you agree that your contributions will be licensed under the [MIT License](LICENSE).
