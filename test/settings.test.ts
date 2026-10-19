import assert from "node:assert/strict";
import { test } from "node:test";
import { stringSchema } from "../lib/schema.ts";
import {
  DEFAULT_SETTINGS,
  MAX_RISKY_PATTERNS,
  parseLanguages,
  parseRiskyPatterns,
  readSettings,
  splitPatterns,
  validateLanguages,
  validateRiskyPatterns,
} from "../lib/settings.ts";

test("languages: validation and parsing", () => {
  assert.equal(validateLanguages("bash,sh,zsh,shell,console"), null);
  assert.equal(validateLanguages(" Bash , zsh "), null);
  assert.equal(validateLanguages(""), null);
  assert.match(validateLanguages("bash,python")!, /Unknown language: python/);
  assert.match(validateLanguages("ps1,fish")!, /Unknown languages: ps1, fish/);
  assert.deepEqual(parseLanguages("BASH, zsh,bash,python"), ["bash", "zsh"]);
  assert.deepEqual(parseLanguages(""), []);
});

test("risky patterns: split with \\, escapes, validate, compile", () => {
  assert.deepEqual(splitPatterns("terraform destroy, kubectl delete ,"), ["terraform destroy", "kubectl delete"]);
  assert.deepEqual(splitPatterns("a{1\\,3}b,c"), ["a{1,3}b", "c"]);
  assert.equal(validateRiskyPatterns(""), null);
  assert.equal(validateRiskyPatterns("^npm publish\\b,\\bdrop table\\b"), null);
  assert.match(validateRiskyPatterns("ok,(unclosed")!, /Not a valid regular expression: \(unclosed/);
  assert.match(validateRiskyPatterns("x".repeat(201))!, /too long/);
  assert.match(validateRiskyPatterns(Array(MAX_RISKY_PATTERNS + 1).fill("a").join(","))!, /At most/);
  const compiled = parseRiskyPatterns("good,(bad,also\\sgood");
  assert.deepEqual(
    compiled.map((r) => r.source),
    ["good", "also\\sgood"],
  );
});

test("schema wrapper reports issues the Standard Schema way", () => {
  const s = stringSchema(validateLanguages)["~standard"];
  assert.deepEqual(s.validate("bash"), { value: "bash" });
  assert.ok("issues" in s.validate("cobol"));
  assert.ok("issues" in s.validate(42));
});

test("readSettings: defaults, valid values, junk", () => {
  assert.deepEqual(readSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings({}), DEFAULT_SETTINGS);
  const got = readSettings({
    languages: "bash,console",
    confirmMode: "every-run",
    terminalMode: "new",
    extraRiskyPatterns: "terraform destroy",
    showOutputPreview: false,
    shellIntegration: false,
  });
  assert.deepEqual(got.languages, ["bash", "console"]);
  assert.equal(got.confirmMode, "every-run");
  assert.equal(got.terminalMode, "new");
  assert.equal(got.extraRiskyPatterns[0]!.source, "terraform destroy");
  assert.equal(got.showOutputPreview, false);
  assert.equal(got.shellIntegration, false);
  const junk = readSettings({ confirmMode: "sometimes", terminalMode: 3, showOutputPreview: "yes", languages: 7 });
  assert.equal(junk.confirmMode, "first-run");
  assert.equal(junk.terminalMode, "reuse");
  assert.equal(junk.showOutputPreview, true);
  assert.deepEqual(junk.languages, DEFAULT_SETTINGS.languages);
});
