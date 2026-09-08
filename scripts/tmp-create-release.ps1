$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# 从 git 凭据管理器取 GitHub 凭据（纯 PowerShell 管道，令牌不落盘、不打印）
$credLines = @("protocol=https", "host=github.com", "") | git credential fill
$credText = ($credLines -join "`n")
$user = [regex]::Match($credText, "username=(.+)").Groups[1].Value.Trim()
$pass = [regex]::Match($credText, "password=(.+)").Groups[1].Value.Trim()
if (-not $user -or -not $pass) { throw "未取到 GitHub 凭据" }
$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${user}:${pass}"))
$headers = @{ Authorization = "Basic $b64"; "User-Agent" = "release-uploader"; Accept = "application/vnd.github+json" }

$body = [System.IO.File]::ReadAllText((Join-Path $root "CHANGELOG.md"), [Text.Encoding]::UTF8)

# 若 v0.1.6 Release 已存在则复用，避免重复创建
$existing = $null
try { $existing = Invoke-RestMethod -Method Get -Uri "https://api.github.com/repos/Jace-Hao/xingqiyi-laundry-photo/releases/tags/v0.1.7" -Headers $headers } catch { $existing = $null }
if ($existing -and $existing.id) {
  $relId = $existing.id
  Write-Output "release exists: id=$relId url=$($existing.html_url)"
} else {
  $payload = @{ tag_name = "v0.1.7"; name = "v0.1.7"; body = $body } | ConvertTo-Json -Depth 5
  $rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/Jace-Hao/xingqiyi-laundry-photo/releases" -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -ContentType "application/json; charset=utf-8"
  $relId = $rel.id
  Write-Output "release created: id=$relId url=$($rel.html_url)"
}

$relDetail = Invoke-RestMethod -Method Get -Uri "https://api.github.com/repos/Jace-Hao/xingqiyi-laundry-photo/releases/$relId" -Headers $headers
$exe = Join-Path $root "dist\xingqiyi-laundry-photo-setup-0.1.7.exe"
foreach ($f in @($exe, "$exe.blockmap")) {
  $name = [System.IO.Path]::GetFileName($f)
  $old = $relDetail.assets | Where-Object { $_.name -eq $name }
  if ($old) { Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/Jace-Hao/xingqiyi-laundry-photo/releases/assets/$($old.id)" -Headers $headers }
  $url = "https://uploads.github.com/repos/Jace-Hao/xingqiyi-laundry-photo/releases/$relId/assets?name=$name"
  $up = Invoke-RestMethod -Method Post -Uri $url -Headers $headers -InFile $f -ContentType "application/octet-stream" -TimeoutSec 1800
  Write-Output ("uploaded: " + $up.name + " state=" + $up.state + " size=" + $up.size)
}

Write-Output "DONE"
