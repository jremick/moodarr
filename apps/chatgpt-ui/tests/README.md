# Local MCP Apps verification

Run the app build, then `npm run test:e2e`. Set `MOODARR_UI_EVIDENCE_DIR` to an absolute evidence directory outside the repository, `MOODARR_UI_POSTER_CACHE_DIR` to an outside-repository image cache, and optionally `MOODARR_UI_CONTRACT_RESULT` to a documented local authenticated backend journey's `poster-contract-result.json`. Without that override, the browser journey uses the built poster enricher with a strict synthetic authenticated fetch fixture. Each receipt identifies its tested boundary.

The visual suite reads the unchanged mockup at `http://127.0.0.1:4178/`. It checks original poster source hashes, resizes copies with the existing macOS `sips` tool, uses the same copies in both reference and production, and saves comparison screenshots plus bundle and asset receipts. No poster binaries are committed. The production iframe receives a representative default MCP Apps CSP that permits raster `data:` images and blocks external connections.

The visual suite also prepares ignored `.artifacts/review-search.json` and `.artifacts/review-detail.json`. With `npm run dev` running on port 4188, open `/tests/host.html?scenario=review-search&width=734&csp=default` or `/tests/host.html?scenario=review-detail&width=820&csp=default`. Mobile review uses a 390px browser viewport, `width=340` for search, and `width=352` for detail, matching the measured reference cards. These fixed local fixture routes are test-host-only; the production entry never imports them.

All accounts, media results, actions, and authenticated transport credentials in these journeys are synthetic. Local browser evidence does not prove live ChatGPT rendering, actual user sign-in, provider registration, or real media execution.

If a comparison capture needs repair, `node tests/compose-evidence.mjs <outside-repository correction/captures directory>` rebuilds dark-search and desktop-detail composites from existing source PNGs. It does not revisit the product or alter production artifacts.
