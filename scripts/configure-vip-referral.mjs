import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";

// Dry-run by default. Run only against the shared identity database on its host.
const args = new Map(process.argv.slice(2).map(arg => {
  const split = arg.indexOf("=");
  return split < 0 ? [arg, "true"] : [arg.slice(0, split), arg.slice(split + 1)];
}));
const dbPath = args.get("--db"), expectedName = args.get("--name");
const apply = args.has("--apply"), operation = args.get("--operation-id");
if (!dbPath || !expectedName || !existsSync(dbPath)) throw Error("Provide --db=/existing/accounts.sqlite and --name=exactNickname. Dry-run is the default.");
if (apply && (!operation || !/^[a-zA-Z0-9_-]{1,80}$/.test(operation) || !args.get("--backup-dir"))) throw Error("Applying requires --operation-id=<stable-id> and --backup-dir=<private-directory>.");
const db = new DatabaseSync(dbPath, { readOnly: !apply });
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
try {
  const rows = db.prepare("SELECT id,name,created_at FROM users WHERE lower(trim(name))=lower(trim(?)) ORDER BY created_at,id").all(expectedName);
  const targetId = args.get("--user-id");
  const candidates = targetId ? rows.filter(row => row.id === targetId) : rows;
  if (candidates.length !== 1) {
    console.log(JSON.stringify({ applied: false, count: candidates.length, candidates: rows }));
    throw Error("An exact unique account is required; resolve ambiguity with --user-id. No account was changed.");
  }
  const target = candidates[0];
  if (!apply) {
    console.log(JSON.stringify({ applied: false, target, planned: { permanentVip: true, rotateReferral: true, registrationGiftDays: 30 }, next: "Repeat with --apply, --user-id, --operation-id and --backup-dir after deploying the updated membership schema." }));
  } else {
    if (!targetId) throw Error("--apply requires --user-id from the dry-run result.");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!["membership_accounts", "membership_permanent", "membership_referral_campaigns"].every(table => tables.has(table))) throw Error("Deploy and initialize the new membership schema before applying this operation.");
    const backupDir = resolve(args.get("--backup-dir"));
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = join(backupDir, `identity-before-${operation}-${Date.now()}.sqlite`);
    db.prepare("VACUUM INTO ?").run(backupPath);
    chmodSync(backupPath, 0o600);
    db.exec("BEGIN IMMEDIATE");
    try {
      const fresh = db.prepare("SELECT id,name FROM users WHERE id=? AND lower(trim(name))=lower(trim(?))").get(target.id, expectedName);
      if (!fresh) throw Error("Account identity changed after the dry-run; stopped.");
      db.exec("CREATE TABLE IF NOT EXISTS membership_referral_rotations(operation_key TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),old_referral_code TEXT,new_referral_code TEXT NOT NULL,created_at INTEGER NOT NULL)");
      const previous = db.prepare("SELECT user_id,new_referral_code FROM membership_referral_rotations WHERE operation_key=?").get(operation);
      if (previous && previous.user_id !== target.id) throw Error("This operation ID belongs to a different user.");
      const current = db.prepare("SELECT referral_code FROM membership_accounts WHERE user_id=?").get(target.id);
      if (previous && current?.referral_code !== previous.new_referral_code) throw Error("Referral changed after this operation; do not overwrite a newer rotation.");
      let code = previous?.new_referral_code;
      if (!code) {
        do { code = randomBytes(5).toString("hex").toUpperCase(); }
        while (code === current?.referral_code || db.prepare("SELECT user_id FROM membership_accounts WHERE referral_code=?").get(code));
      }
      const now = Date.now();
      db.prepare("INSERT INTO membership_accounts(user_id,referral_code) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET referral_code=excluded.referral_code").run(target.id, code);
      db.prepare("INSERT OR IGNORE INTO membership_permanent(user_id,granted_at) VALUES(?,?)").run(target.id, now);
      db.prepare("INSERT INTO membership_referral_campaigns(inviter_id,referral_code,days,created_at) VALUES(?,?,30,?) ON CONFLICT(inviter_id) DO UPDATE SET referral_code=excluded.referral_code,days=30").run(target.id, code, now);
      db.prepare("INSERT OR IGNORE INTO membership_referral_rotations(operation_key,user_id,old_referral_code,new_referral_code,created_at) VALUES(?,?,?,?,?)").run(operation, target.id, current?.referral_code || null, code, now);
      db.exec("COMMIT");
      console.log(JSON.stringify({ applied: true, alreadyApplied: !!previous, target, permanentVip: true, referralCode: code, registrationGiftDays: 30, backupPath }));
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
} finally { db.close(); }
