import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { knowledgeWorkerPackage } from './knowledge-worker-package.js';
import { extractWorkerPackage } from '../../scripts/knowledge-worker-launcher.mjs';

test('packaged PowerShell scripts have UTF8 BOM; scheduling binds task names and paths correctly on Windows PowerShell 5.1', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge schedule 测试 '));
  try {
    await extractWorkerPackage(knowledgeWorkerPackage().buffer, directory);
    for (const file of ['setup-knowledge-worker.ps1', 'install-knowledge-worker.ps1', 'start-knowledge-worker.ps1']) {
      assert.deepEqual((await fs.readFile(path.join(directory, 'scripts', file))).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    }
    const config = path.join(directory, 'private config.json'); await fs.writeFile(config, '{}');
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const driver = `
$ErrorActionPreference='Stop'
$global:registered=$null; $global:started=''
function New-ScheduledTaskAction { param($Execute,$Argument) return @{Execute=$Execute;Argument=$Argument} }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User) return @{User=$User;AtLogOn=$AtLogOn.IsPresent} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) return @{UserId=$UserId;LogonType=$LogonType;RunLevel=$RunLevel} }
function New-ScheduledTaskSettingsSet { param([switch]$StartWhenAvailable,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit,$MultipleInstances,$RestartCount,$RestartInterval) return @{RestartCount=$RestartCount} }
function Register-ScheduledTask { [CmdletBinding(PositionalBinding=$false)]param($TaskName,$Action,$Trigger,$Principal,$Settings,$Description,[switch]$Force) $global:registered=@{TaskName=$TaskName;Action=$Action;Description=$Description;Principal=$Principal} }
function Start-ScheduledTask { param($TaskName) $global:started=$TaskName }
& ${quote(path.join(directory, 'scripts/install-knowledge-worker.ps1'))} -ConfigPath ${quote(config)} -NodePath ${quote(process.execPath)} | Out-Null
if($global:registered.TaskName -ne 'Navigation Knowledge GPU Worker' -or $global:started -ne 'Navigation Knowledge GPU Worker'){throw 'Incorrect task name'}
if($global:registered.Principal.RunLevel -ne 'Limited' -or $global:registered.Principal.LogonType -ne 'Interactive'){throw 'Unexpected principal'}
if(-not $global:registered.Action.Argument.Contains(${quote('"' + config + '"')})){throw 'Missing quoted config path'}
Write-Output 'SCHEDULER_BINDING_OK'
`;
    const driverFile = path.join(directory, 'verify.ps1');
    await fs.writeFile(driverFile, '\ufeff' + driver);
    const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const installer = path.join(directory, 'scripts/install-knowledge-worker.ps1');
    const good = await fs.readFile(installer);
    const legacy = good.toString('utf8').replace(/^\ufeff/, '').replace('Navigation knowledge GPU worker; start after sign-in and retry on failure.', '本机视频知识库 GPU 工作器，登录后自动启动，异常退出自动重试。')
      .replace('Knowledge GPU worker started; automatic startup after Windows sign-in is enabled.', '本机 GPU 工作器已启动，并配置为当前用户登录后自动运行。');
    await fs.writeFile(installer, legacy, 'utf8');
    await assert.rejects(promisify(execFile)(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driverFile], { timeout: 20000, windowsHide: true }), /PositionalParameterNotFound/);
    await fs.writeFile(installer, good);
    const { stdout, stderr } = await promisify(execFile)(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driverFile], { timeout: 20000, windowsHide: true });
    assert.match(stdout, /SCHEDULER_BINDING_OK/); assert.equal(stderr.trim(), '');
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir()); await fs.rm(directory, { recursive: true, force: true });
  }
});
