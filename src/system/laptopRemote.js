import { spawn } from "child_process";
import os from "os";
import path from "path";
import { config } from "../core/config.js";
import { redactSecrets, truncateOutput } from "../utils/security.js";
import { logger } from "../core/logger.js";

const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const commandTimeoutMs = 30000;

export function runPowerShell(script, { timeoutMs = commandTimeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        powershell,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        {
          cwd: config.appRoot,
          windowsHide: true,
          env: {
            ...process.env,
            FORCE_COLOR: "0",
            NO_COLOR: "1"
          }
        }
      );
    } catch (error) {
      resolve({ ok: false, output: `[spawn error] ${error.message}` });
      return;
    }

    let output = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, output: truncateOutput(`${output}\n[timeout] PowerShell timeout.`) });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, output: truncateOutput(`[powershell error] ${error.message}\n${output}`) });
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: code === 0,
        exitCode: code,
        output: truncateOutput(redactSecrets(output || ""), 12000)
      });
    });
  });
}

function parseJsonArray(output) {
  let text = String(output || "").trim();
  if (!text) return [];
  // Bersihkan karakter kontrol yang tidak di-escape (seperti bel \x07) yang membuat JSON.parse crash
  text = text.replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F]/g, "");
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.error("JSON parse error di laptopRemote:", err.message, text);
    return [];
  }
}

export async function listActiveDesktopApps({ limit = 20 } = {}) {
  if (process.platform !== "win32") {
    return { ok: false, apps: [], output: "Fitur remote laptop saat ini hanya untuk Windows." };
  }

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-Process |
  Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0 } |
  Sort-Object ProcessName, Id |
  Select-Object -First ${Number(limit)} @{n='pid';e={$_.Id}}, @{n='name';e={$_.ProcessName}}, @{n='title';e={$_.MainWindowTitle}} |
  ConvertTo-Json -Compress
`;
  const result = await runPowerShell(script);
  if (!result.ok) {
    await logger.warn("Gagal membaca aplikasi aktif", { output: result.output });
    return { ok: false, apps: [], output: result.output };
  }

  return { ok: true, apps: parseJsonArray(result.output), output: result.output };
}

export async function closeDesktopApp(pid) {
  if (process.platform !== "win32") {
    return { ok: false, output: "Fitur remote laptop saat ini hanya untuk Windows." };
  }

  const numericPid = Number.parseInt(pid, 10);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { ok: false, output: "PID aplikasi tidak valid." };
  }

  const script = `
$ErrorActionPreference = 'Stop'
$p = Get-Process -Id ${numericPid} -ErrorAction Stop
$name = $p.ProcessName
$title = $p.MainWindowTitle
$closed = $false
if ($p.MainWindowHandle -ne 0) {
  $closed = $p.CloseMainWindow()
  Start-Sleep -Milliseconds 1200
}
$alive = Get-Process -Id ${numericPid} -ErrorAction SilentlyContinue
if ($alive) {
  Stop-Process -Id ${numericPid} -Force -ErrorAction Stop
  $status = 'killed'
} elseif ($closed) {
  $status = 'closed'
} else {
  $status = 'not_running'
}
[pscustomobject]@{ ok = $true; pid = ${numericPid}; name = $name; title = $title; status = $status } | ConvertTo-Json -Compress
`;
  const result = await runPowerShell(script);
  if (!result.ok) return { ok: false, output: result.output };
  const [detail] = parseJsonArray(result.output);
  return { ok: true, detail, output: result.output };
}

let cachedLaunchableApps = null;
let lastLaunchableAppsFetch = 0;
const CACHE_DURATION = 15 * 60 * 1000; // 15 menit cache

export async function listLaunchableApps({ limit = 30, query = "", forceRefresh = false } = {}) {
  if (process.platform !== "win32") {
    return { ok: false, apps: [], output: "Fitur remote laptop saat ini hanya untuk Windows." };
  }

  const now = Date.now();
  if (forceRefresh || !cachedLaunchableApps || (now - lastLaunchableAppsFetch) > CACHE_DURATION) {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$folder = $shell.NameSpace('shell:::{4234d49b-0245-4df3-b780-3893943456e1}')
$items = $folder.Items() | Select-Object -Property @{n='name';e={$_.Name}}, @{n='path';e={$_.Name}}
$items | Sort-Object name -Unique | ConvertTo-Json -Compress
`;
    const result = await runPowerShell(script);
    if (result.ok) {
      cachedLaunchableApps = parseJsonArray(result.output);
      lastLaunchableAppsFetch = now;
    } else {
      await logger.warn("Gagal membaca daftar aplikasi", { output: result.output });
      if (!cachedLaunchableApps) {
        return { ok: false, apps: [], output: result.output };
      }
    }
  }

  let filtered = cachedLaunchableApps || [];
  if (query) {
    const lowerQuery = query.toLowerCase();
    filtered = filtered.filter(app => app.name && app.name.toLowerCase().includes(lowerQuery));
  }

  return { ok: true, apps: filtered.slice(0, limit), output: JSON.stringify(filtered.slice(0, limit)) };
}

// Preload cache di background agar saat user mengklik menu, respon instan 0ms!
if (process.platform === "win32") {
  setTimeout(() => {
    listLaunchableApps({ forceRefresh: true }).catch(() => {});
  }, 2000);
}

export async function openDesktopApp(shortcutPath) {
  if (process.platform !== "win32") {
    return { ok: false, output: "Fitur remote laptop saat ini hanya untuk Windows." };
  }

  const normalized = String(shortcutPath || "").trim();
  if (!normalized) {
    return { ok: false, output: "Shortcut atau nama aplikasi tidak valid." };
  }

  const encodedPath = Buffer.from(normalized, "utf8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))

$shell = New-Object -ComObject Shell.Application
$folder = $shell.NameSpace('shell:::{4234d49b-0245-4df3-b780-3893943456e1}')
$item = $folder.Items() | Where-Object { $_.Name -eq $name } | Select-Object -First 1

if ($item) {
    $item.InvokeVerb('open')
    [pscustomobject]@{ ok = $true; path = $name } | ConvertTo-Json -Compress
} else {
    if (Test-Path -LiteralPath $name) {
        Start-Process explorer.exe -ArgumentList """$name"""
        [pscustomobject]@{ ok = $true; path = $name } | ConvertTo-Json -Compress
    } else {
        throw "Aplikasi tidak ditemukan: $name"
    }
}
`;
  const result = await runPowerShell(script);
  if (!result.ok) return { ok: false, output: result.output };
  return { ok: true, output: result.output };
}

export async function captureDesktopScreenshot() {
  if (process.platform !== "win32") {
    return { ok: false, output: "Fitur screenshot laptop saat ini hanya untuk Windows." };
  }

  const outputPath = path.join(os.tmpdir(), `telegram-laptop-screenshot-${Date.now()}.png`);
  const encodedPath = Buffer.from(outputPath, "utf8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
[pscustomobject]@{ ok = $true; path = $path; width = $bounds.Width; height = $bounds.Height } | ConvertTo-Json -Compress
`;
  const result = await runPowerShell(script, { timeoutMs: 15000 });
  if (!result.ok) return { ok: false, output: result.output };
  const [detail] = parseJsonArray(result.output);
  return { ok: true, path: detail?.path || outputPath, detail, output: result.output };
}

const BROWSER_EXE_MAP = {
  brave: "brave",
  chrome: "chrome",
  edge: "msedge",
  firefox: "firefox",
};

export function isBrowserApp(appName) {
  const lower = (appName || "").toLowerCase();
  return Object.keys(BROWSER_EXE_MAP).some(b => lower.includes(b))
    || lower.includes("browser");
}

export function detectBrowserExe(appName) {
  const lower = (appName || "").toLowerCase();
  for (const [key, exe] of Object.entries(BROWSER_EXE_MAP)) {
    if (lower.includes(key)) return exe;
  }
  return null;
}

export async function openUrl(url, browserName) {
  if (process.platform !== "win32") {
    return { ok: false, output: "Fitur ini hanya untuk Windows." };
  }

  let normalized = String(url || "").trim();
  if (!normalized) return { ok: false, output: "URL kosong." };
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;

  const exe = browserName ? detectBrowserExe(browserName) : null;
  const encodedUrl = Buffer.from(normalized, "utf8").toString("base64");
  const script = exe
    ? `
$url = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUrl}'))
Start-Process "${exe}" $url
[pscustomobject]@{ ok = $true; url = $url; browser = "${exe}" } | ConvertTo-Json -Compress
`
    : `
$url = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUrl}'))
Start-Process $url
[pscustomobject]@{ ok = $true; url = $url; browser = "default" } | ConvertTo-Json -Compress
`;
  const result = await runPowerShell(script);
  if (!result.ok) return { ok: false, output: result.output };
  const [detail] = parseJsonArray(result.output);
  return { ok: true, detail, output: result.output };
}

export async function adjustVolume(action) {
  if (process.platform !== "win32") {
    return { ok: false, output: "Fitur volume hanya untuk Windows." };
  }

  let charCode;
  if (action === "up") charCode = 175;
  else if (action === "down") charCode = 174;
  else if (action === "mute") charCode = 173;
  else return { ok: false, output: "Aksi volume tidak dikenal." };

  const script = `
$wobj = New-Object -ComObject WScript.Shell
$wobj.SendKeys([char]${charCode})
[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
`;
  const result = await runPowerShell(script);
  return { ok: result.ok, output: result.output };
}

export async function controlMedia(action) {
  if (process.platform !== "win32") {
    return { ok: false, output: "Fitur media hanya untuk Windows." };
  }

  let charCode;
  if (action === "playpause") charCode = 179;
  else if (action === "next") charCode = 176;
  else if (action === "prev") charCode = 177;
  else return { ok: false, output: "Aksi media tidak dikenal." };

  const script = `
$wobj = New-Object -ComObject WScript.Shell
$wobj.SendKeys([char]${charCode})
[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
`;
  const result = await runPowerShell(script);
  return { ok: result.ok, output: result.output };
}
