// Migration guard (CI): a migration that may already be applied somewhere must never change.
//
//   node scripts/check-migrations.mjs <base-ref>      e.g. origin/main
//
// Compared with <base-ref> (what is live), every file in supabase/migrations that already exists there must
// be unchanged and still present, and each new migration must sort after the newest one there, so that
// `supabase db push` applies it in order on staging and live. Exits 1 with a plain message otherwise.
import { execFileSync } from "node:child_process";

const base = process.argv[2];
if (!base) { console.error("usage: node scripts/check-migrations.mjs <base-ref>"); process.exit(2); }
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const DIR = "supabase/migrations/";

const baseFiles = git("ls-tree", "--name-only", base, DIR).split("\n").filter((f) => f.endsWith(".sql")).sort();
const newest = baseFiles.at(-1) ?? "";
const problems = [];

for (const line of git("diff", "--name-status", "--no-renames", base, "--", DIR).split("\n").filter(Boolean)) {
  const [status, file] = line.split("\t");
  const name = file.slice(DIR.length);
  if (status === "M") problems.push(`${name} was edited. It may already be applied; add a new migration instead.`);
  else if (status === "D") problems.push(`${name} was deleted. Applied migrations must stay; add a new one that undoes it instead.`);
  else if (status === "A" && file.endsWith(".sql") && file < newest) {
    problems.push(`${name} sorts before ${newest.slice(DIR.length)}, the newest migration already in ${base}. Give it a later number.`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log(`Migrations OK against ${base}: ${baseFiles.length} existing unchanged, new ones after ${newest.slice(DIR.length) || "(none)"}.`);
