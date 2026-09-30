$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tokenPath = Join-Path $repoRoot '.supabase-cli-token.tmp'
$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$createdFile = $false
$secureToken = $null
$nativeToken = [IntPtr]::Zero
$tokenBytes = $null
$fileStream = $null

if (Test-Path -LiteralPath $tokenPath) {
    throw "Refusing to overwrite an existing temporary credential file: $tokenPath"
}

try {
    $secureToken = Read-Host 'Supabase access token (input is hidden)' -AsSecureString
    if ($secureToken.Length -eq 0) {
        throw 'The access token was empty.'
    }

    $fileStream = [System.IO.File]::Open(
        $tokenPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    $createdFile = $true
    $fileStream.Dispose()
    $fileStream = $null

    $fileSecurity = [System.Security.AccessControl.FileSecurity]::new()
    $fileSecurity.SetOwner($currentUserSid)
    $fileSecurity.SetAccessRuleProtection($true, $false)
    $userRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $currentUserSid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $fileSecurity.AddAccessRule($userRule)
    Set-Acl -LiteralPath $tokenPath -AclObject $fileSecurity

    $verifiedAcl = Get-Acl -LiteralPath $tokenPath
    $verifiedRules = @(
        $verifiedAcl.GetAccessRules(
            $true,
            $true,
            [System.Security.Principal.SecurityIdentifier]
        )
    )
    if (
        -not $verifiedAcl.AreAccessRulesProtected -or
        $verifiedRules.Count -ne 1 -or
        $verifiedRules[0].IdentityReference.Value -ne $currentUserSid.Value -or
        $verifiedRules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl
    ) {
        throw 'Could not verify an ACL limited to the current Windows user.'
    }

    $nativeToken = [System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secureToken)
    $tokenBytes = [byte[]]::new($secureToken.Length * 2)
    [System.Runtime.InteropServices.Marshal]::Copy($nativeToken, $tokenBytes, 0, $tokenBytes.Length)

    $fileStream = [System.IO.File]::Open(
        $tokenPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    $fileStream.Write($tokenBytes, 0, $tokenBytes.Length)
    $fileStream.Flush($true)
    $fileStream.Dispose()
    $fileStream = $null

    Write-Output "Temporary token file prepared with current-user-only access: $tokenPath"
} catch {
    if ($fileStream) {
        $fileStream.Dispose()
    }
    if ($createdFile -and (Test-Path -LiteralPath $tokenPath)) {
        Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue
    }
    throw
} finally {
    if ($tokenBytes) {
        [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
    }
    if ($nativeToken -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($nativeToken)
    }
    if ($secureToken) {
        $secureToken.Dispose()
    }
}
