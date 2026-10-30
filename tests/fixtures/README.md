# Test fixtures (test-only)

`extraction/*.json` are recorded/hand-written extraction outputs in the exact
shape the extraction provider returns. They are loaded only by
`tests/fixtures/fixture-extractor.ts`, which tests install through
`setDocumentDepsForTests` (refuses to run outside `NODE_ENV=test`). They are
never used by the application or the worker.
