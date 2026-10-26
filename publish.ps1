# 一键发布到 GitHub（Windows PowerShell）
#
# 用法：
#   .\publish.ps1 -Token "ghp_你的token"
#
# 它会：
#   1) 用 GitHub API 建仓库（如果还没有）
#   2) 把远程指过去
#   3) push 到 main
#
# 注：本机到 GitHub 的证书被中间人拦了，所以这里给 git 关掉了 sslVerify（仅这个仓库）。

param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$RepoName = 'dsh-Abyssal-Node-memory',
  [string]$UserName = '',
  [string]$Visibility = 'public'
)

$ErrorActionPreference = 'Stop'
$git = 'C:\Program Files\Git\cmd\git.exe'
if (-not (Test-Path $git)) { $git = 'git' }

Set-Location $PSScriptRoot

# 1) 我是谁
$headers = @{
  Authorization          = "token $Token"
  'User-Agent'           = 'dsh-abyssal-node-memory'
  Accept                 = 'application/vnd.github+json'
}
$me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers
if (-not $UserName) { $UserName = $me.login }
Write-Host "账号：$UserName" -ForegroundColor Cyan

# 2) 建仓库（已存在就跳过）
$body = @{ name = $RepoName; description = 'dsh-Abyssal Node-memory — persistent memory loop for Koishi'; private = ($Visibility -ne 'public') } | ConvertTo-Json
try {
  Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers $headers -Body $body -ContentType 'application/json' | Out-Null
  Write-Host "仓库已创建：$RepoName" -ForegroundColor Green
} catch {
  Write-Host "仓库可能已存在，继续推送" -ForegroundColor Yellow
}

# 3) 推送
& $git config http.sslVerify false
$remote = "https://$UserName`:$Token@github.com/$UserName/$RepoName.git"
& $git remote remove origin 2>$null
& $git remote add origin $remote
& $git push -u origin main

Write-Host ""
Write-Host "完成：https://github.com/$UserName/$RepoName" -ForegroundColor Green
Write-Host "记得回 GitHub 把这个 token 删掉（Settings → Developer settings → Tokens）" -ForegroundColor Yellow
