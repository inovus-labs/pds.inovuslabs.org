#!/usr/bin/env node
// Snapshot the account's public data from the PDS into a local folder:
//   <out>/<snapshot>/repo.car       full signed repo (importable with com.atproto.repo.importRepo)
//   <out>/<snapshot>/blobs/<cid>    every blob, verified against its CID
//   <out>/<snapshot>/manifest.json  commit, rev, record counts, blob list
// Uses only public endpoints, so no credentials are needed. Node 20+, no dependencies.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PDS = process.env.PDS_URL ?? "https://pds.inovuslabs.org";
const DID = process.env.DID ?? "did:plc:2fftr5c2q5za7tbw5fmoowjt";
const OUT = process.argv[2] ?? "backup-out";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(bytes) {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out;
}

function base32Decode(str) {
	let bits = 0;
	let value = 0;
	const out = [];
	for (const char of str) {
		value = (value << 5) | B32.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Uint8Array.from(out);
}

async function xrpc(nsid, params, { binary = false } = {}) {
	const url = `${PDS}/xrpc/${nsid}?${new URLSearchParams(params)}`;
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(url, { headers: { "user-agent": "pds-backup" } });
		if (res.ok) {
			return binary ? new Uint8Array(await res.arrayBuffer()) : res.json();
		}
		if (attempt >= 3 || res.status < 500) {
			throw new Error(`${nsid} failed: ${res.status} ${await res.text()}`);
		}
		await new Promise((r) => setTimeout(r, attempt * 2000));
	}
}

// CAR v1 header: varint length, then DAG-CBOR {roots: [CID], version: 1}.
// Roots are CBOR tag 42 wrapping a byte string of 0x00 + binary CID.
function carRoot(car) {
	let len = 0;
	let shift = 0;
	let i = 0;
	for (;;) {
		const b = car[i++];
		len |= (b & 0x7f) << shift;
		if (!(b & 0x80)) break;
		shift += 7;
	}
	const header = car.subarray(i, i + len);
	const tag = header.findIndex((b, j) => b === 0xd8 && header[j + 1] === 0x2a);
	if (tag < 0) throw new Error("CAR header has no root CID");
	let p = tag + 2;
	let size = header[p++] & 0x1f;
	if (size === 24) size = header[p++];
	return `b${base32Encode(header.subarray(p + 1, p + size))}`;
}

// A blob CID is CIDv1 whose multihash is sha2-256 (0x12, 32 bytes) of the content.
function blobMatchesCid(cid, bytes) {
	const raw = base32Decode(cid.slice(1));
	const digest = raw.subarray(raw.length - 32);
	const sha = createHash("sha256").update(bytes).digest();
	return (
		cid.startsWith("b") &&
		raw[raw.length - 34] === 0x12 &&
		raw[raw.length - 33] === 0x20 &&
		Buffer.from(digest).equals(sha)
	);
}

const before = await xrpc("com.atproto.sync.getLatestCommit", { did: DID });
const car = await xrpc("com.atproto.sync.getRepo", { did: DID }, { binary: true });
const root = carRoot(car);
const after = await xrpc("com.atproto.sync.getLatestCommit", { did: DID });
if (root !== after.cid && root !== before.cid) {
	throw new Error(`CAR root ${root} matches neither latest commit (${before.cid}, ${after.cid})`);
}
const commit = root === after.cid ? after : before;

const { collections } = await xrpc("com.atproto.repo.describeRepo", { repo: DID });
// Count unique URIs and stop when a page adds nothing new: Cirrus 0.19.0
// repeats the cursor record at page boundaries (ascorbic/cirrus#251).
const recordCounts = {};
for (const collection of collections) {
	const uris = new Set();
	let cursor;
	for (;;) {
		const page = await xrpc("com.atproto.repo.listRecords", {
			repo: DID,
			collection,
			limit: "100",
			...(cursor ? { cursor } : {}),
		});
		const sizeBefore = uris.size;
		for (const record of page.records) uris.add(record.uri);
		if (!page.cursor || uris.size === sizeBefore) break;
		cursor = page.cursor;
	}
	recordCounts[collection] = uris.size;
}

const cids = [];
let cursor;
do {
	const page = await xrpc("com.atproto.sync.listBlobs", {
		did: DID,
		limit: "1000",
		...(cursor ? { cursor } : {}),
	});
	cids.push(...page.cids);
	cursor = page.cids.length ? page.cursor : undefined;
} while (cursor);

const takenAt = new Date().toISOString();
const snapshot = takenAt.replace(/[:.]/g, "").replace(/\d{3}Z$/, "Z");
const dir = join(OUT, snapshot);
await mkdir(join(dir, "blobs"), { recursive: true });
await writeFile(join(dir, "repo.car"), car);

const blobs = [];
for (const cid of cids) {
	const bytes = await xrpc("com.atproto.sync.getBlob", { did: DID, cid }, { binary: true });
	if (!blobMatchesCid(cid, bytes)) throw new Error(`blob ${cid} does not match its CID`);
	await writeFile(join(dir, "blobs", cid), bytes);
	blobs.push({ cid, size: bytes.length });
}

const manifest = {
	did: DID,
	pds: PDS,
	takenAt,
	commit: commit.cid,
	rev: commit.rev,
	car: {
		file: "repo.car",
		size: car.length,
		sha256: createHash("sha256").update(car).digest("hex"),
	},
	records: Object.values(recordCounts).reduce((a, b) => a + b, 0),
	recordCounts,
	blobCount: blobs.length,
	blobs,
};
await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

console.log(
	`snapshot ${snapshot}: rev ${commit.rev}, ${manifest.records} records, ${blobs.length} blobs, ${car.length} byte CAR`,
);
if (process.env.GITHUB_OUTPUT) {
	await writeFile(process.env.GITHUB_OUTPUT, `snapshot=${snapshot}\n`, { flag: "a" });
}
