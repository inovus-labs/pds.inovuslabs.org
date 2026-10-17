// Posts the backup result and a live health check of the account to Discord.
import { readFileSync } from "node:fs";

const {
	DISCORD_WEBHOOK_URL,
	SNAPSHOT,
	SNAPSHOT_RESULT,
	UPLOAD_RESULT,
	MANIFEST,
	PDS_URL,
	DID,
	RECOVERY_KEY,
	GITHUB_REPOSITORY,
	GITHUB_RUN_ID,
	GITHUB_SERVER_URL,
} = process.env;

if (!DISCORD_WEBHOOK_URL) {
	console.log("DISCORD_WEBHOOK_URL not set, skipping notification");
	process.exit(0);
}

const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
const BOT_NAME = "PDS Backup Bot";
const BOT_AVATAR = "https://bsky.app/static/apple-touch-icon.png";

let manifest;
try {
	manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch {}
const ok = SNAPSHOT_RESULT === "success" && UPLOAD_RESULT === "success" && manifest;

async function get(url, headers = {}) {
	try {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
		const data = await res.json().catch(() => undefined);
		return { ok: res.ok, status: res.status, data };
	} catch {
		return { ok: false, status: 0 };
	}
}
const answered = (r) => r.status > 0 && r.status < 500;

const [profile, health, plc, latest, relay] = await Promise.all([
	get(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${DID}`),
	get(`${PDS_URL}/xrpc/_health`),
	get(`https://plc.directory/${DID}/data`),
	get(`${PDS_URL}/xrpc/com.atproto.sync.getLatestCommit?did=${DID}`),
	get(`https://bsky.network/xrpc/com.atproto.sync.getRepoStatus?did=${DID}`),
]);
const handle =
	plc.data?.alsoKnownAs?.find((a) => a.startsWith("at://"))?.slice(5) ?? profile.data?.handle;
const dns = handle
	? await get(`https://cloudflare-dns.com/dns-query?name=_atproto.${handle}&type=TXT`, {
			accept: "application/dns-json",
		})
	: { ok: false, status: 0 };

const PASS = "pass";
const FAIL = "fail";
const UNKNOWN = "unknown";
const icon = { [PASS]: "✅", [FAIL]: "❌", [UNKNOWN]: "❔" };

function identityCheck() {
	if (!plc.ok) return [UNKNOWN, "plc.directory unreachable"];
	const endpoint = plc.data.services?.atproto_pds?.endpoint;
	return endpoint === PDS_URL ? [PASS, "DID → this PDS"] : [FAIL, `DID → ${endpoint ?? "no PDS"}`];
}

function handleCheck() {
	if (!handle) return [UNKNOWN, "Handle unknown"];
	if (!dns.ok || ![0, 3].includes(dns.data?.Status)) return [UNKNOWN, "DNS lookup failed"];
	const records = (dns.data.Answer ?? []).map((a) => a.data.replaceAll('"', ""));
	return records.includes(`did=${DID}`) ? [PASS, "DNS TXT → DID"] : [FAIL, "TXT record missing"];
}

function relayCheck() {
	if (!answered(relay)) return [UNKNOWN, "Relay unreachable"];
	if (!relay.ok || !relay.data?.active) return [FAIL, "Not active on relay"];
	if (!latest.ok) return [UNKNOWN, "Can't compare (PDS down)"];
	return relay.data.rev === latest.data.rev ? [PASS, "Active, in sync"] : [FAIL, "Behind the PDS"];
}

function appViewCheck() {
	if (!answered(profile)) return [UNKNOWN, "AppView unreachable"];
	return profile.ok ? [PASS, "Profile served"] : [FAIL, profile.data?.message ?? "Profile missing"];
}

function rotationCheck() {
	if (!plc.ok) return [UNKNOWN, "plc.directory unreachable"];
	const keys = plc.data.rotationKeys ?? [];
	return keys.length === 1 && keys[0] === RECOVERY_KEY
		? [PASS, "Recovery key only"]
		: [FAIL, "Changed — check plc.directory"];
}

const checks = [
	["PDS", health.ok && health.data?.status === "ok" ? [PASS, "Online"] : [FAIL, "Not responding"]],
	["Identity", identityCheck()],
	["Handle", handleCheck()],
	["Relay", relayCheck()],
	["AppView", appViewCheck()],
	["Rotation keys", rotationCheck()],
];
const version = health.data?.version ?? "cirrus";
// Several PDSes report to the same channel.
const label = handle ?? new URL(PDS_URL).hostname;

const healthy = checks.every(([, [state]]) => state !== FAIL);
const healthFields = checks.map(([name, [state, text]]) => ({
	name,
	value: `${icon[state]} ${text}`,
	inline: true,
}));

const size = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`);
const spacer = { name: "​", value: "​", inline: true };

const APPS = { "app.bsky": "Bluesky", "chat.bsky": "Bluesky", "sh.tangled": "Tangled" };

function appFields(recordCounts) {
	const groups = new Map();
	for (const [nsid, count] of Object.entries(recordCounts)) {
		const parts = nsid.split(".");
		const app = APPS[parts.slice(0, 2).join(".")] ?? parts.slice(0, 2).join(".");
		const word = parts.at(-1).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
		const name = count === 1 ? word : word.endsWith("s") ? `${word}es` : `${word}s`;
		if (!groups.has(app)) groups.set(app, []);
		groups.get(app).push([count, name]);
	}
	const fields = [...groups]
		.map(([app, items]) => ({ app, items, total: items.reduce((n, [c]) => n + c, 0) }))
		.sort((a, b) => b.total - a.total)
		.map(({ app, items, total }) => ({
			name: `${app} (${total})`,
			value: `${items
				.sort((a, b) => b[0] - a[0])
				.map(([c, name]) => `**${c}** ${name}`)
				.join("\n")
				.slice(0, 1000)}\n​`,
			inline: true,
		}));
	while (fields.length % 3) fields.push(spacer);
	return fields;
}

let embed;
if (ok) {
	const bytes = manifest.car.size + manifest.blobs.reduce((n, b) => n + b.size, 0);
	embed = {
		title: `PDS Backup — ${healthy ? "Success" : "Warning"} · ${label}`,
		url: runUrl,
		color: healthy ? 0x1185fe : 0xf5a524,
		fields: [
			{ name: "Records", value: `**${manifest.records}**`, inline: true },
			{ name: "Blobs", value: `**${manifest.blobCount}**`, inline: true },
			{ name: "Size", value: `**${size(bytes)}**`, inline: true },
			...appFields(manifest.recordCounts),
			...healthFields.map((f, i) => (i >= healthFields.length - 3 ? { ...f, value: `${f.value}\n\u200b` } : f)),
			{ name: "Version", value: version, inline: true },
			spacer,
			{ name: "Snapshot", value: `\`${SNAPSHOT}\``, inline: true },
		],
	};
} else {
	const failed =
		SNAPSHOT_RESULT !== "success"
			? "Reading from the PDS failed"
			: UPLOAD_RESULT !== "success"
				? "Upload to R2 failed"
				: "Manifest missing";
	embed = {
		title: `PDS Backup — Failed · ${label}`,
		url: runUrl,
		color: 0xe5484d,
		description: `${failed} · [logs](${runUrl})`,
		fields: healthFields,
		footer: { text: version },
	};
}

const res = await fetch(DISCORD_WEBHOOK_URL, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		username: BOT_NAME,
		avatar_url: BOT_AVATAR,
		embeds: [embed],
	}),
});

if (!res.ok) {
	console.error(`Discord webhook failed: ${res.status} ${res.statusText}\n${await res.text()}`);
	process.exit(1);
}

console.log("Discord notification sent");
