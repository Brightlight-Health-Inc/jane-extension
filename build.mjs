#!/usr/bin/env node
/**
 * Package the extension for private distribution.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * This extension is not in the Chrome Web Store, and for now it should not be:
 * it is used by clinics we are onboarding, once, under supervision. Everything
 * below is about making "not in the store" a deliberate distribution channel
 * rather than a pile of files on someone's desktop.
 *
 * ── WHY IT WRITES ITS OWN ZIP AND CRX ───────────────────────────────────────
 *
 * `chrome.exe --pack-extension` would do this, but it makes the build depend on
 * a Chrome install being present and on which Chrome it is. This script has no
 * dependencies at all — Node's crypto and zlib are enough — so the same bytes
 * come out on a laptop and in CI.
 *
 * Builds are deterministic: file order is sorted and every timestamp is pinned,
 * so rebuilding the same commit yields a byte-identical package. That is what
 * makes "the clinic is running exactly what we shipped" a checkable claim
 * instead of an assurance.
 *
 * ── WHY IT SIGNS ────────────────────────────────────────────────────────────
 *
 * A Chrome extension's ID is derived from its public key. Pinning the key in the
 * manifest and signing with the matching private one means:
 *
 *   - the ID never changes, so `externally_connectable` in the manifest and
 *     EXTENSION_ID in the app stay true across every rebuild and every clinic;
 *   - an update replaces the extension in place instead of installing a second
 *     copy beside it;
 *   - policy-managed installs can auto-update from `update.xml`.
 *
 * The private key lives OUTSIDE this repository (see KEY_PATH). Losing it means
 * every clinic's extension ID changes and every install has to be redone by
 * hand, so it belongs in the password manager, not in git.
 *
 * Usage:  node build.mjs [--out dist] [--key <path>]
 */

import {createHash, createPrivateKey, createPublicKey, createSign} from "node:crypto";
import {deflateRawSync} from "node:zlib";
import {mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from "node:fs";
import {dirname, join, relative, sep} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY = join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "keys", "brightlight-migrator.pem");

/** Everything the browser needs, and nothing else. Build tooling and notes stay out. */
const SHIP = ["manifest.json", "panel.html", "panel.js", "16.png", "48.png", "128.png", "src"];

// Where a policy-managed Chrome looks for new versions. Absolute, because the
// browser fetches it with no page context, and pinned to one canonical host
// rather than a tenant subdomain — every tenant serves the same bundle, and an
// update URL that named one clinic would be a lie about the other forty.
const UPDATE_BASE = "https://clinic.brightlight.ai/extension";

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const OUT = join(ROOT, arg("out", "dist"));
const KEY_PATH = arg("key", DEFAULT_KEY);

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * A ZIP with every timestamp pinned to the epoch DOS allows (1980-01-01).
 *
 * Chrome does not care what the dates say, and a real clock would make two
 * builds of the same source differ — which is exactly the property worth having.
 */
const DOS_TIME = 0;
const DOS_DATE = 33; // 1980-01-01

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const {name, data} of entries) {
    const compressed = deflateRawSync(data, {level: 9});
    // Storing beats deflating when deflating makes it bigger (tiny files, PNGs).
    const deflated = compressed.length < data.length;
    const body = deflated ? compressed : data;
    const method = deflated ? 8 : 0;
    const crc = crc32(data);
    const nameBytes = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

// ---------------------------------------------------------------------------
// crx3
// ---------------------------------------------------------------------------

function varint(value) {
  const bytes = [];
  let n = value;
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    bytes.push(byte);
  } while (n);
  return Buffer.from(bytes);
}

/** protobuf length-delimited field: tag, then length, then payload. */
function field(number, payload) {
  return Buffer.concat([varint((number << 3) | 2), varint(payload.length), payload]);
}

/**
 * The extension ID Chrome will show: the first 16 bytes of the public key's
 * SHA-256, rendered in the alphabet `a`–`p` rather than hex.
 */
function extensionId(publicKeyDer) {
  const digest = createHash("sha256").update(publicKeyDer).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .split("")
    .map((character) => String.fromCharCode(97 + parseInt(character, 16)))
    .join("");
}

function packCrx(zipBuffer, privateKey) {
  const publicKeyDer = createPublicDer(privateKey);
  const crxId = createHash("sha256").update(publicKeyDer).digest().subarray(0, 16);

  // SignedData { bytes crx_id = 1 }
  const signedHeaderData = field(1, crxId);

  // The signature covers a domain-separated prefix, the length of the signed
  // header, the header itself, and then the archive — so a signature cannot be
  // lifted from one CRX onto another.
  const toSign = Buffer.concat([
    Buffer.from("CRX3 SignedData\x00", "binary"),
    (() => {
      const length = Buffer.alloc(4);
      length.writeUInt32LE(signedHeaderData.length, 0);
      return length;
    })(),
    signedHeaderData,
    zipBuffer,
  ]);

  const signature = createSign("RSA-SHA256").update(toSign).sign(privateKey);

  // AsymmetricKeyProof { public_key = 1, signature = 2 }
  const proof = Buffer.concat([field(1, publicKeyDer), field(2, signature)]);
  // CrxFileHeader { sha256_with_rsa = 2, signed_header_data = 10000 }
  const header = Buffer.concat([field(2, proof), field(10000, signedHeaderData)]);

  const preamble = Buffer.alloc(12);
  preamble.write("Cr24", 0, "binary");
  preamble.writeUInt32LE(3, 4); // CRX3
  preamble.writeUInt32LE(header.length, 8);

  return {crx: Buffer.concat([preamble, header, zipBuffer]), publicKeyDer};
}

function createPublicDer(privateKey) {
  // SubjectPublicKeyInfo — the same encoding that goes in `manifest.key`, base64'd.
  // Derived from the private key rather than read from a second file, so the two
  // cannot drift apart.
  return createPublicKey(privateKey).export({type: "spki", format: "der"});
}

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

function collect() {
  const files = [];
  for (const target of SHIP) {
    const full = join(ROOT, target);
    const stats = statSync(full);
    for (const file of stats.isDirectory() ? walk(full) : [full]) {
      files.push({
        // Zip paths are forward-slashed regardless of platform; Chrome rejects
        // the backslashes Windows would otherwise produce here.
        name: relative(ROOT, file).split(sep).join("/"),
        data: readFileSync(file),
      });
    }
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : 1));
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const {version} = manifest;

let privateKey;
try {
  privateKey = createPrivateKey(readFileSync(KEY_PATH));
} catch (error) {
  console.error(`\nCannot read the signing key at:\n  ${KEY_PATH}\n`);
  console.error("It is deliberately outside this repository. Restore it from the password");
  console.error("manager, or pass another with --key. Signing with a DIFFERENT key changes");
  console.error("the extension ID, which breaks every existing install.\n");
  process.exit(1);
}

const publicKeyDer = createPublicDer(privateKey);
const id = extensionId(publicKeyDer);
const declared = manifest.key;
const actual = publicKeyDer.toString("base64");

// The manifest pins the public key, and the ID the app talks to is derived from
// it. If the two ever disagree, every install silently stops answering the page
// — so disagreeing is a build failure, not a warning.
if (declared !== actual) {
  console.error("\nThe key pinned in manifest.json does not match the signing key.\n");
  console.error(`  manifest.key -> ${extensionId(Buffer.from(declared, "base64"))}`);
  console.error(`  signing key  -> ${id}\n`);
  process.exit(1);
}

mkdirSync(OUT, {recursive: true});

const files = collect();
const archive = zip(files);
const {crx} = packCrx(archive, privateKey);

const zipName = `brightlight-migrator-${version}.zip`;
const crxName = `brightlight-migrator-${version}.crx`;

writeFileSync(join(OUT, zipName), archive);
writeFileSync(join(OUT, crxName), crx);

// Two audiences, two naming rules.
//
// The .crx is fetched by Chrome's updater at the exact URL `update.xml` names,
// so it is versioned and may be cached forever — a new build is a new URL.
//
// The .zip is fetched by a person clicking a link in the install guide. A
// versioned name there would mean every release silently rots that link, so it
// also gets a stable one. Stable means mutable, which means the deploy has to
// give it a short cache, same as `update.xml`.
writeFileSync(join(OUT, "brightlight-migrator.zip"), archive);

writeFileSync(
  join(OUT, "update.xml"),
  `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${UPDATE_BASE}/${crxName}' version='${version}' />
  </app>
</gupdate>
`
);

const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

writeFileSync(
  join(OUT, "SHA256SUMS.txt"),
  [
    `${sha(archive)}  ${zipName}`,
    `${sha(crx)}  ${crxName}`,
    "",
    `extension id: ${id}`,
    `version:      ${version}`,
    "",
    "Builds are deterministic — rebuilding this commit must reproduce these digests.",
    "",
  ].join("\n")
);

console.log(`\nBrightlight Migrator ${version}`);
console.log(`  id       ${id}`);
console.log(`  files    ${files.length}`);
console.log(`  zip      ${zipName}  (${(archive.length / 1024).toFixed(1)} kB)`);
console.log(`  crx      ${crxName}  (${(crx.length / 1024).toFixed(1)} kB)`);
console.log(`  also     brightlight-migrator.zip (stable link), update.xml, SHA256SUMS.txt`);
console.log(`  out      ${OUT}\n`);
