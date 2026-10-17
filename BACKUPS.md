# Backups

A weekly GitHub Action ([.github/workflows/backup.yml](.github/workflows/backup.yml)) runs [scripts/backup.mjs](scripts/backup.mjs) on Sundays at 03:17 UTC. It can also be started by hand from the Actions tab ("Run workflow").

Every run, including failed ones, posts to Discord ([scripts/notify.mjs](scripts/notify.mjs)): records, blobs, size and records per app on success, or which step failed, plus live health checks (PDS online, DID → PDS, handle, relay in sync, AppView, rotation keys still recovery-only). Each check shows ✅ OK, ❌ a real problem, or ❔ the service it relies on didn't answer. The embed turns amber if the backup worked but a check shows ❌; ❔ alone doesn't change the colour. It uses the `DISCORD_WEBHOOK_URL` repo secret, the same webhook as `decoded-cipher/pds-arjunkrishna`, so each title names the handle. Without that secret the step is skipped.

## What a snapshot contains

```
<snapshot>/                e.g. 2026-10-10T202409Z
  repo.car                 full signed repo; its root is checked against getLatestCommit
  blobs/<cid>              every blob; each file is checked against its CID
  manifest.json            commit, rev, record counts per collection, blob list, CAR sha256
```

Everything comes from public endpoints, so the snapshot holds no secrets. Preferences (muted words, saved feeds) are private and not included. They are small and easy to set again.

## Where snapshots go

`pds-inovuslabs-blobs/backups/<snapshot>/` in R2. Each snapshot is kept for 182 days (lifecycle rule `expire-backups`) and can't be deleted or overwritten for the first 30 (lock rule `backups-30d`).

Cirrus 0.19.0 only reads and deletes keys under `did:plc:2fftr5c2q5za7tbw5fmoowjt/`, so `backups/` is outside its reach. Check this again when upgrading (see [UPGRADING.md](UPGRADING.md)).

The Action's R2 token (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` repo secrets) is limited to this bucket, but R2 tokens can't be limited to a prefix, so it can also write the live blob folder. Treat it like any other production credential.

## Restoring

To a fresh Cirrus PDS (new Worker, or this one after `pds deactivate` and `pds migrate --clean`):

1. Download a snapshot from R2 (dashboard, or `aws s3 cp --recursive` with the R2 endpoint).
2. Import the repo: `POST /xrpc/com.atproto.repo.importRepo` with `repo.car` as the body (`Content-Type: application/vnd.ipld.car`, `Authorization: Bearer <AUTH_TOKEN>`).
3. Upload each file in `blobs/` with `POST /xrpc/com.atproto.repo.uploadBlob`, then check `com.atproto.repo.listMissingBlobs` is empty.
4. Compare `pds status` with `manifest.json` (rev, record and blob counts).
5. If the PDS hostname or signing key changed, point the DID at it with the recovery key: `goat plc update --pds … --atproto-key …`, then `goat plc sign` and `goat plc submit`.
6. `pds activate`.
