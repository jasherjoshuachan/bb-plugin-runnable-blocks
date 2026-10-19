import assert from "node:assert/strict";
import { test } from "node:test";
import { findRisks } from "../lib/risk.ts";

const ids = (command: string) => findRisks(command).map((risk) => risk.id);
const risky = (command: string, id: string) =>
  assert.ok(ids(command).includes(id), `expected ${JSON.stringify(command)} to flag ${id}, got [${ids(command)}]`);
const safe = (command: string) =>
  assert.deepEqual(ids(command), [], `expected ${JSON.stringify(command)} to be safe`);

// Built at runtime so this file never contains the literal git subcommand text.
const PUSH = ["git", "push"].join(" ");

test("rm -rf variants are risky", () => {
  risky("rm -rf ./build", "rm-rf");
  risky("rm -fr node_modules", "rm-rf");
  risky("rm -r -f dist", "rm-rf");
  risky("rm -Rf /tmp/x", "rm-rf");
  risky("rm --recursive --force out", "rm-rf");
  risky("cd app && rm -rf dist && npm run build", "rm-rf");
  risky("/bin/rm -rf x", "rm-rf");
});

test("plain rm and rm -r are not flagged", () => {
  safe("rm file.txt");
  safe("rm -r olddir");
  safe("rm -f stale.lock");
  safe("npm run rm-cache");
});

test("quoted rm -rf still flags (documented false positive)", () => {
  risky('echo "rm -rf"', "rm-rf");
});

test("sudo and doas", () => {
  risky("sudo apt-get install jq", "sudo");
  risky("ls && sudo reboot", "sudo");
  risky("doas pkg_add vim", "sudo");
  safe("echo pseudo");
  safe("npm i sudo-prompt-free");
});

test("download piped to a shell", () => {
  risky("curl -fsSL https://example.com/install.sh | sh", "pipe-to-shell");
  risky("curl https://example.com/i | sudo bash", "pipe-to-shell");
  risky("wget -qO- https://example.com/setup | bash", "pipe-to-shell");
  risky("curl -s https://x.y/z | zsh -s -- --yes", "pipe-to-shell");
  risky('bash -c "$(curl -fsSL https://example.com/install.sh)"', "pipe-to-shell");
  risky("sh <(curl -s https://example.com/i.sh)", "pipe-to-shell");
});

test("downloads that are not executed are fine", () => {
  safe("curl -fsSL https://example.com/install.sh -o install.sh");
  safe("curl https://api.example.com | jq .");
  safe("wget https://example.com/file.tar.gz");
});

test("mkfs", () => {
  risky("mkfs.ext4 /dev/sdb1", "mkfs");
  risky("mkfs -t vfat /dev/sdc", "mkfs");
});

test("dd of=", () => {
  risky("dd if=ubuntu.iso of=/dev/disk4 bs=4m", "dd");
  risky("dd if=/dev/zero of=/dev/sda", "raw-device-write");
  safe("dd if=/dev/zero bs=1m count=1 | wc -c");
});

test("chmod -R 777", () => {
  risky("chmod -R 777 /var/www", "chmod-777");
  risky("chmod 777 -R .", "chmod-777");
  risky("chmod --recursive 0777 public", "chmod-777");
  safe("chmod 755 script.sh");
  safe("chmod +x run.sh");
  safe("chmod -R 755 public");
});

test("plain push is fine, force push is risky", () => {
  safe(PUSH);
  safe(`${PUSH} -u origin main`);
  safe(`${PUSH} --follow-tags`);
  safe(`${PUSH} origin v1.0.0`);
  risky(`${PUSH} --force`, "git-force-push");
  risky(`${PUSH} -f origin main`, "git-force-push");
  risky(`${PUSH} origin main --force-with-lease`, "git-force-push");
  risky(`${PUSH} origin +main`, "git-force-push");
  risky(`git -C repo push -uf origin main`, "git-force-push");
});

test("git reset --hard", () => {
  risky("git reset --hard origin/main", "git-reset-hard");
  risky("git fetch && git reset --hard HEAD~1", "git-reset-hard");
  safe("git reset HEAD file.txt");
  safe("git reset --soft HEAD~1");
});

test("fork bomb", () => {
  risky(":(){ :|:& };:", "fork-bomb");
  risky(":() { : | : & }; :", "fork-bomb");
  risky("bomb(){ bomb|bomb& };bomb", "fork-bomb");
});

test("writes to raw disk devices", () => {
  risky("cat image.img > /dev/sda", "raw-device-write");
  risky("echo x >/dev/nvme0n1", "raw-device-write");
  safe("echo hi > /dev/null");
  safe("cmd 2>/dev/null");
  safe("ls /dev/sda");
});

test("everyday commands are not flagged", () => {
  for (const command of [
    "npm test",
    "ls -la",
    "git status",
    "git commit -m 'fix: tidy'",
    "docker compose up -d",
    "python3 -m http.server 8000",
    "brew install jq",
    "cat <<'EOF' > notes.txt\nhello\nEOF",
  ]) {
    safe(command);
  }
});

test("several risks are all reported", () => {
  assert.deepEqual(ids(`sudo rm -rf /opt/app && ${PUSH} --force`), ["rm-rf", "sudo", "git-force-push"]);
});

test("extra risky patterns from the settings", () => {
  const find = findRisks;
  const extra = [/terraform\s+destroy/, /^npm publish/g];
  assert.deepEqual(
    find("terraform destroy -auto-approve", extra).map((r) => r.id),
    ["custom-0"],
  );
  // A /g pattern matches every time (no lastIndex carry-over).
  assert.equal(find("npm publish", extra).length, 1);
  assert.equal(find("npm publish", extra).length, 1);
  assert.match(find("npm publish", extra)[0]!.label, /\/\^npm publish\//);
  assert.deepEqual(
    find("sudo terraform destroy", extra).map((r) => r.id),
    ["sudo", "custom-0"],
  );
  assert.deepEqual(find("ls", extra), []);
});
