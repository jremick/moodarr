## Summary

- 

## Verification

- [ ] `npm run verify`
- [ ] `npm run eval:recommendations`
- [ ] `npm run test:packaging`
- [ ] `npm run smoke:container` when packaging/runtime changed

## Safety

- [ ] No Plex, Seerr, OpenAI, admin tokens, private hostnames, screenshots, or support bundles are included.
- [ ] Plex library and catalog access remain read-only; any Watchlist write stays explicit and user-initiated.
- [ ] Seerr request creation remains explicit and confirmed.
