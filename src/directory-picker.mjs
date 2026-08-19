import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function existingInitialDirectory(value) {
  let candidate = String(value || '').trim();
  if (!candidate || !path.isAbsolute(candidate)) return '';
  candidate = path.normalize(candidate);
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return '';
    candidate = parent;
  }
  return candidate;
}

async function pickOnWindows(initialPath) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = '选择新的项目目录'",
    '$dialog.ShowNewFolderButton = $true',
    '$initial = $env:SESSION_MANAGER_INITIAL_DIRECTORY',
    "if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $dialog.SelectedPath = $initial }",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Write($dialog.SelectedPath) }",
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_MANAGER_INITIAL_DIRECTORY: initialPath },
    windowsHide: true,
  });
  return stdout.trim();
}

async function pickOnMac(initialPath) {
  const prompt = initialPath
    ? ['-e', 'on run argv', '-e', 'set chosen to choose folder with prompt "选择新的项目目录" default location POSIX file (item 1 of argv)', '-e', 'POSIX path of chosen', '-e', 'end run', initialPath]
    : ['-e', 'POSIX path of (choose folder with prompt "选择新的项目目录")'];
  try {
    const { stdout } = await execFileAsync('osascript', prompt, { encoding: 'utf8' });
    return stdout.trim();
  } catch (error) {
    if (error?.code === 1 && /User canceled|-128/i.test(`${error.stderr || ''} ${error.message || ''}`)) return '';
    throw error;
  }
}

async function pickOnLinux(initialPath) {
  const args = ['--file-selection', '--directory', '--title=选择新的项目目录'];
  if (initialPath) args.push(`--filename=${initialPath}${path.sep}`);
  try {
    const { stdout } = await execFileAsync('zenity', args, { encoding: 'utf8' });
    return stdout.trim();
  } catch (error) {
    if (error?.code === 1) return '';
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    const { stdout } = await execFileAsync('kdialog', ['--getexistingdirectory', initialPath || '.'], { encoding: 'utf8' });
    return stdout.trim();
  } catch (error) {
    if (error?.code === 1) return '';
    throw error;
  }
}

export async function pickDirectory({ initialPath = '', platform = process.platform } = {}) {
  const initialDirectory = existingInitialDirectory(initialPath);
  let selected;
  if (platform === 'win32') selected = await pickOnWindows(initialDirectory);
  else if (platform === 'darwin') selected = await pickOnMac(initialDirectory);
  else if (platform === 'linux') selected = await pickOnLinux(initialDirectory);
  else throw new Error(`Directory selection is not supported on ${platform}.`);
  return selected ? path.normalize(selected) : null;
}
