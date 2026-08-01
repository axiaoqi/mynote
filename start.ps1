$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ProjectDir
$env:UV_CACHE_DIR = Join-Path $ProjectDir ".uv-cache"
$PythonExe = Join-Path $ProjectDir ".venv\Scripts\python.exe"

try {
    $EnvironmentReady = $false
    if (Test-Path -LiteralPath $PythonExe) {
        & $PythonExe -c "import bleach, flask, markdown, waitress" 2>$null
        $EnvironmentReady = $LASTEXITCODE -eq 0
    }

    if (-not $EnvironmentReady) {
        if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
            throw "Python dependencies are missing and uv was not found. Install uv, then run start.bat again."
        }
        Write-Host "Preparing MyNote for the first run..." -ForegroundColor Yellow
        & uv sync
        if ($LASTEXITCODE -ne 0) {
            throw "uv could not prepare the Python environment. See the uv error above."
        }
    }

    if (-not (Test-Path -LiteralPath $PythonExe)) {
        throw "The project Python environment was not created: $PythonExe"
    }

    function Test-MyNotePort([int]$Port) {
        $Listener = $null
        try {
            $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
            $Listener.Start()
            return $true
        } catch {
            return $false
        } finally {
            if ($Listener) { $Listener.Stop() }
        }
    }

    $Port = @(5000, 8055, 8056, 8057) |
        Where-Object { Test-MyNotePort $_ } |
        Select-Object -First 1
    if (-not $Port) {
        throw "None of the MyNote ports (5000, 8055-8057) can be opened. Check Windows firewall and reserved ports."
    }

    $DefaultRoute = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
        Where-Object { $_.NextHop -ne "0.0.0.0" } |
        Sort-Object RouteMetric |
        Select-Object -First 1
    $LanAddress = if ($DefaultRoute) {
        Get-NetIPAddress -InterfaceIndex $DefaultRoute.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
            Select-Object -First 1 -ExpandProperty IPAddress
    } else {
        Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
            Select-Object -First 1 -ExpandProperty IPAddress
    }

    Write-Host ""
    Write-Host "MyNote is starting" -ForegroundColor Green
    if ($Port -ne 5000) {
        Write-Host "Port 5000 is unavailable; using port $Port instead." -ForegroundColor DarkYellow
    }
    Write-Host "Computer: http://127.0.0.1:$Port"
    if ($LanAddress) {
        Write-Host "Phone:    http://${LanAddress}:$Port" -ForegroundColor Cyan
    } else {
        Write-Host "No LAN address was detected. Check the Wi-Fi connection." -ForegroundColor DarkYellow
    }
    Write-Host "Press Ctrl+C to stop the service."
    Write-Host ""

    & $PythonExe -m waitress "--listen=0.0.0.0:$Port" wsgi:application
    if ($LASTEXITCODE -ne 0) {
        throw "The MyNote web service exited with code $LASTEXITCODE. Check the error shown above."
    }
    exit 0
} catch {
    Write-Host ""
    Write-Host "MyNote could not start:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
