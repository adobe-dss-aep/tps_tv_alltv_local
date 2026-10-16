import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const windows = await readFile(new URL("../install-windows.ps1", import.meta.url), "utf8");
const mac = await readFile(new URL("../install-macos.command", import.meta.url), "utf8");
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === "psmodulepath") delete env[key];
}

function ps(body) {
  const script = `
    $ErrorActionPreference = 'Stop'
    $tokens=$null; $errors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile('${root.replaceAll("'", "''")}install-windows.ps1',[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'Parse failed'}
    foreach($name in @('Read-ConsentAnswer','Confirm-YesNo','Get-ClaudeProcesses','Stop-ClaudeWithConsent')){
      $definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
      . ([ScriptBlock]::Create($definition.Extent.Text))
    }
    ${body}`;
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env, encoding: "utf8" });
}

test("Windows prompts accept yes/no, retry invalid answers, and deny missing Claude", { skip: process.platform !== "win32" }, () => {
  const result = ps(`
    $script:answers=[Collections.Generic.Queue[string]]::new()
    @('maybe','YES','n','no') | ForEach-Object {$script:answers.Enqueue($_)}
    function Read-ConsentAnswer {param($Prompt) $script:answers.Dequeue()}
    if(-not (Confirm-YesNo 'Stop?')){throw 'yes rejected'}
    if(Confirm-YesNo 'Stop?'){throw 'no accepted'}
    try {
      if(-not (Confirm-YesNo 'Install?')){throw 'This install requires Claude Desktop'}
      throw 'Decline should fail'
    } catch {if($_.Exception.Message -ne 'This install requires Claude Desktop'){throw}}
    Write-Output 'CONSENT_OK'
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Please answer yes or no/);
  assert.match(result.stdout, /CONSENT_OK/);
});

test("Windows stops every captured Claude PID only after yes; no leaves processes alone", { skip: process.platform !== "win32" }, () => {
  const result = ps(`
    $script:stopped=@()
    function Get-ClaudeProcesses {
      foreach($id in @(101,202,303)){if($id -notin $script:stopped){[PSCustomObject]@{Id=$id}}}
    }
    function Get-Process {param($Id) [PSCustomObject]@{Id=$Id}}
    function Stop-Process {param($Id,[switch]$Force,$ErrorAction) $script:stopped += $Id}
    function Read-ConsentAnswer {param($Prompt) 'no'}
    try {Stop-ClaudeWithConsent; throw 'Decline should cancel'} catch {
      if($_.Exception.Message -notlike 'Installation cancelled*'){throw}
    }
    if($script:stopped.Count){throw 'Stopped processes without consent'}
    function Read-ConsentAnswer {param($Prompt) 'yes'}
    Stop-ClaudeWithConsent
    if(($script:stopped -join ',') -ne '101,202,303'){throw 'Did not stop all Claude PIDs'}
    Write-Output 'ALL_PIDS_OK'
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ALL_PIDS_OK/);
});

test("Windows includes Claude helpers but not unrelated applications", { skip: process.platform !== "win32" }, () => {
  const result = ps(`
    function Get-Process {
      foreach($name in @('Claude','Claude Helper','Claude Helper (GPU)','NotClaude','node')){
        [PSCustomObject]@{ProcessName=$name}
      }
    }
    if(@(Get-ClaudeProcesses).Count -ne 3){throw 'Unexpected Claude process match'}
  `);
  assert.equal(result.status, 0, result.stderr);
});

test("Windows reports EOF instead of looping or assuming consent", { skip: process.platform !== "win32" }, () => {
  const result = ps(`
    function Read-ConsentAnswer {param($Prompt) return $null}
    try {Confirm-YesNo 'Continue?'; throw 'EOF should fail'} catch {
      if($_.Exception.Message -notlike 'No answer received*'){throw}
    }
    Write-Output 'EOF_OK'
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /EOF_OK/);
});

const macFunctions = mac.slice(mac.indexOf("fail()"), mac.indexOf("while [[ $#"));
test("Mac consent retries invalid input, accepts yes/no, and fails explicitly at EOF", { skip: process.platform !== "darwin" }, () => {
  for (const [input, expected] of [["maybe\nyes\n", 0], ["no\n", 1], ["", 1]]) {
    const result = spawnSync("/bin/bash", ["-c", `${macFunctions}\nconfirm_yes_no 'Continue?'`], { input, encoding: "utf8" });
    assert.equal(result.status, expected, result.stderr);
    if (input.startsWith("maybe")) assert.match(result.stdout, /Please answer yes or no/);
    if (!input) assert.match(result.stderr, /No answer received/);
  }
});

test("Mac stops all captured Claude PIDs only after consent", { skip: process.platform !== "darwin" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "alltv-consent-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const answer of ["no", "yes"]) {
    const marker = join(directory, answer);
    const result = spawnSync("/bin/bash", ["-c", `${macFunctions}
      claude_pids() { [[ -f "$MARKER" ]] || printf '101\\n202\\n'; }
      kill() {
        if [[ "$1" == -TERM ]]; then printf '%s\\n' "$2" >> "$MARKER"; fi
        return 0
      }
      stop_claude_with_consent
    `], { env: { ...env, MARKER: marker }, input: `${answer}\n`, encoding: "utf8" });
    assert.equal(result.status, answer === "yes" ? 0 : 1, result.stderr);
    if (answer === "yes") assert.equal(await readFile(marker, "utf8"), "101\n202\n");
    else await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
});

test("missing-Claude decline uses the required message on both platforms", () => {
  assert.match(windows, /Confirm-YesNo 'Claude Desktop is not installed\. Install it now\?'/);
  assert.match(windows, /throw 'This install requires Claude Desktop'/);
  assert.match(mac, /confirm_yes_no "Claude Desktop is not installed\. Install it now\?" \|\| fail "This install requires Claude Desktop"/);
});
