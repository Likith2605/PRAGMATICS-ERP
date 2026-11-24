
$ErrorActionPreference = "Stop"

$PgBin = "C:\Program Files\PostgreSQL\18\bin"
$PgDump = "$PgBin\pg_dump.exe"
$PgRestore = "$PgBin\pg_restore.exe"

$BackupDir = "E:\Pragmatics1\DB_Backups"
$Database = "pragmatics1_test_db"
$LogFile = "$BackupDir\automatic_backup.log"

$env:PGPASSFILE = "$env:APPDATA\postgresql\pgpass.conf"

try {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

    $Date = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
    $BackupFile = "$BackupDir\pragmatics1_$Date.backup"
    $TempFile = "$BackupFile.partial"

    "[$(Get-Date)] Starting backup" |
        Out-File $LogFile -Append

    & $PgDump -h localhost -p 5432 -U postgres `
        -d $Database -F c -f $TempFile

    if ($LASTEXITCODE -ne 0) {
        throw "pg_dump failed"
    }

    & $PgRestore -l $TempFile *> $null

    if ($LASTEXITCODE -ne 0) {
        throw "Backup validation failed"
    }

    Move-Item $TempFile $BackupFile

    "[$(Get-Date)] SUCCESS: $BackupFile" |
        Out-File $LogFile -Append

    # Retain the latest 30 days of dated backups.
    Get-ChildItem $BackupDir -Filter "pragmatics1_20*.backup" |
        Where-Object {
            $_.LastWriteTime -lt (Get-Date).AddDays(-30)
        } |
        Remove-Item -Force
}
catch {
    "[$(Get-Date)] ERROR: $_" |
        Out-File $LogFile -Append

    throw
}
finally {
    Remove-Item Env:\PGPASSFILE -ErrorAction SilentlyContinue
}
