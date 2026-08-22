#!/usr/bin/env node
/**
 * Substitute the site's `[[PLACEHOLDER]]` values and write web/dist/.
 *
 * The site has no framework and needs none — this exists for one reason: every page is written
 * with `[[NAME]]` where a real value has not been decided, and nothing was checking that they
 * all got replaced. Shipping `[[SUPPORT_EMAIL]]` on a public legal page, or an empty
 * `[[API_BASE_URL]]` that leaves pricing and password reset silently dead, is a deploy away at
 * any moment.
 *
 * So this refuses to produce output it is not happy with, rather than printing a warning
 * nobody reads. Run it, fix what it names, run it again.
 *
 *   node web/build.mjs          (or: npm run build:web)
 */
import { readFile, writeFile, mkdir, rm, readdir, copyFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WEB = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(WEB, "..");
const OUT = path.join(WEB, "dist");
const CONFIG = path.join(WEB, "site.config.json");

/** Files that describe the site to developers rather than being part of it. */
const NOT_SHIPPED = new Set(["README.md", "build.mjs", "site.config.json", "dist"]);

/** Only text formats are scanned; an image containing `[[` is a coincidence, not a placeholder. */
const SUBSTITUTABLE = new Set([".html", ".css", ".js", ".json", ".txt", ".xml", ".svg"]);

/**
 * The four screenshots are allowed to be missing, and nothing else is.
 *
 * A site with no support address is broken; a site with no screenshots is unfinished. The
 * layout already reserves their space, so the second one ships and warns rather than blocking
 * a deploy that is otherwise correct.
 */
const OPTIONAL = /^SHOT_/;

/** A 1×1 transparent GIF. An empty `src` is not "no image" — browsers treat it as a request
 *  for the page itself, which fetches the whole document a second time. */
const BLANK =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const errors = [];
const warnings = [];

async function walk(dir, base = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (base === "" && NOT_SHIPPED.has(entry.name)) continue;
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

/**
 * `GRACE_DAYS` is a promise to customers that a nightly job enforces, stated as text on the
 * legal pages and as a constant in the Worker. Two copies of one number in two languages is
 * exactly the kind of thing that drifts, and the one that drifts is the page, silently.
 */
async function serverGraceDays() {
  const src = await readFile(path.join(ROOT, "server/src/cleanup.ts"), "utf8").catch(() => null);
  if (src === null) {
    warnings.push("could not read server/src/cleanup.ts — GRACE_DAYS not cross-checked");
    return null;
  }
  const m = src.match(/LAPSE_GRACE_DAYS\s*=\s*(\d+)/);
  if (!m) {
    warnings.push("LAPSE_GRACE_DAYS not found in server/src/cleanup.ts — GRACE_DAYS not cross-checked");
    return null;
  }
  return m[1];
}

function checkValues(config, used) {
  for (const name of used) {
    if (!(name in config)) {
      errors.push(`[[${name}]] is used by the site but missing from site.config.json`);
      continue;
    }
    const value = String(config[name] ?? "").trim();
    if (value) continue;
    if (OPTIONAL.test(name)) {
      warnings.push(`[[${name}]] is empty — that image ships as a blank frame`);
    } else {
      errors.push(`[[${name}]] is empty in site.config.json`);
    }
  }
  for (const name of Object.keys(config)) {
    if (!used.has(name)) warnings.push(`site.config.json sets ${name}, which no page uses`);
  }
}

function checkShapes(config) {
  for (const key of ["API_BASE_URL", "DOWNLOAD_URL"]) {
    const v = String(config[key] ?? "").trim();
    if (v && !/^https?:\/\/[^\s]+$/.test(v)) {
      errors.push(`${key} is not a URL: ${JSON.stringify(v)}`);
    }
  }
  const email = String(config.SUPPORT_EMAIL ?? "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push(`SUPPORT_EMAIL is not an email address: ${JSON.stringify(email)}`);
  }
  // Named in the README: payment providers reject a free mailbox on the merchant record.
  if (/@(gmail|yahoo|hotmail|outlook|icloud)\./i.test(email)) {
    warnings.push(`SUPPORT_EMAIL is a free mailbox (${email}) — payment providers usually reject one`);
  }
}

const config = JSON.parse(
  await readFile(CONFIG, "utf8").catch(() => {
    console.error(`Missing ${path.relative(ROOT, CONFIG)} — copy the keys from web/README.md.`);
    process.exit(1);
  })
);

const files = await walk(WEB);
const used = new Set();
const text = new Map();
for (const rel of files) {
  if (!SUBSTITUTABLE.has(path.extname(rel))) continue;
  const body = await readFile(path.join(WEB, rel), "utf8");
  text.set(rel, body);
  for (const m of body.matchAll(/\[\[([A-Z0-9_]+)\]\]/g)) used.add(m[1]);
}

checkValues(config, used);
checkShapes(config);

const serverDays = await serverGraceDays();
const siteDays = String(config.GRACE_DAYS ?? "").trim();
if (serverDays && siteDays && serverDays !== siteDays) {
  errors.push(
    `GRACE_DAYS is ${siteDays} but the Worker deletes after ${serverDays} ` +
      `(LAPSE_GRACE_DAYS in server/src/cleanup.ts). The pages state this as a promise to customers.`
  );
}

if (errors.length) {
  console.error(`\nweb/dist not written — ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  for (const w of warnings) console.error(`  · ${w}`);
  console.error("");
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
for (const rel of files) {
  const dest = path.join(OUT, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  const body = text.get(rel);
  if (body === undefined) {
    await copyFile(path.join(WEB, rel), dest);
    continue;
  }
  const filled = body.replace(/\[\[([A-Z0-9_]+)\]\]/g, (_, name) => {
    const value = String(config[name] ?? "").trim();
    return value || (OPTIONAL.test(name) ? BLANK : `[[${name}]]`);
  });
  // Belt and braces: a substitution that quietly failed would otherwise reach the web.
  const left = filled.match(/\[\[[A-Z0-9_]+\]\]/g);
  if (left) {
    console.error(`\nweb/dist not written — ${rel} still contains ${[...new Set(left)].join(", ")}\n`);
    await rm(OUT, { recursive: true, force: true });
    process.exit(1);
  }
  await writeFile(dest, filled);
}

const bytes = (await Promise.all((await walk(OUT)).map((r) => stat(path.join(OUT, r)))))
  .reduce((n, s) => n + s.size, 0);
for (const w of warnings) console.log(`  · ${w}`);
console.log(
  `\nweb/dist ready — ${files.length} files, ${(bytes / 1024).toFixed(0)} KB.` +
    `\nDeploy: npx wrangler pages deploy web/dist --project-name capture-studio-site\n`
);
