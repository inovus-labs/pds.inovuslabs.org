# Upgrading

This PDS runs published releases of [`@getcirrus/pds`](https://www.npmjs.com/package/@getcirrus/pds), pinned to an exact version in `package.json`. Upgrade when upstream ([ascorbic/cirrus](https://github.com/ascorbic/cirrus)) publishes a new release.

## Check for a release

```bash
npm view @getcirrus/pds version        # latest published
pnpm ls @getcirrus/pds                 # what we run
```

Release notes: https://github.com/ascorbic/cirrus/blob/main/packages/pds/CHANGELOG.md

## Steps

1. Read the changelog between our version and the new one. Look for breaking changes, new `wrangler.jsonc` bindings or migrations, and new required vars or secrets.
2. Run a backup first: Actions → "Backup PDS" → Run workflow.
3. Set the exact new version in `package.json`, then `pnpm install`.
4. Remove workarounds that the release makes unnecessary (below).
5. `pnpm build` must succeed.
6. `pnpm run deploy`
7. `pnpm pds status` should end with "All checks passed!". Then open bsky.app and check the timeline loads and a post or like goes through.
8. If R2 handling changed, check that Cirrus still only touches keys under `did:plc:2fftr5c2q5za7tbw5fmoowjt/` (see [BACKUPS.md](BACKUPS.md)).

To roll back: `pnpm wrangler rollback` returns to the previous Worker version. Then put the old version back in `package.json`.

## Temporary workarounds (remove when fixed upstream)

| Workaround | Where | Why | Remove when |
|---|---|---|---|
| `pnpm.overrides` pinning `@atproto/common` and `@atproto/common-web` to `0.0.0-spaces-alpha-20260818163953` | `package.json` | 0.19.0 can't be installed fresh (ascorbic/cirrus#254) | a release includes #255 |
| Re-exporting `SpaceDurableObject` and `SpaceIndexDurableObject` | `src/index.ts` | the `create-pds` 0.1.0 template predates ascorbic/cirrus#248 | never: this matches the current template, keep it |
| Backup script de-duplicates `listRecords` pages | `scripts/backup.mjs` | ascorbic/cirrus#251 | harmless to keep |

## Identity changes

The DID's only rotation key is the recovery key (in Apple Passwords, plus an offline copy). Cirrus can't change the DID. For any identity change (handle, PDS host, signing key):

```bash
goat plc update did:plc:2fftr5c2q5za7tbw5fmoowjt --handle … > op.json   # or --pds / --atproto-key
PLC_SIGNING_KEY=… goat plc sign op.json > op.signed.json
goat plc submit --did did:plc:2fftr5c2q5za7tbw5fmoowjt op.signed.json
```

Once a release ships ascorbic/cirrus#253 (`pds rotation-keys`), we can decide whether to add the Cirrus key as a second rotation key.
