# slicc-kernel

SLICC's wasm-realm kernel as a standalone package: it runs Emscripten programs built for SLICC (first target: GNU bash from `@ai-ecoverse/wasm-bash`) in the browser, directly against the Origin Private File System, with fork, spawn, pipes and `waitpid`.

Work in progress. The API lands with the kernel itself.

## Development

```sh
npm install
npm run lint
npm test
```

`npm test` runs the integration tests in Chromium from `playwright-core`, over raw CDP. Each test writes screenshots, console logs and one CPU profile per target to `artifacts/`; V8 coverage from the page and its workers goes to `coverage/`, and `artifacts/hotspots.md` lists where the time went.

Unit tests live in `test/unit/`, which stays out of git. The pre-commit hook runs them under coverage and requires every changed line in `src/` to be covered.

## License

Apache-2.0
