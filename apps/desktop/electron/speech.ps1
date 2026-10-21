$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$speechRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
$speechSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    if ($speechRequest.action -eq 'voices') {
        $speechVoices = @($speechSynth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
            @{ id = $_.VoiceInfo.Name; name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name }
        })
        ConvertTo-Json -InputObject $speechVoices -Compress
    } else {
        if ($speechRequest.voice) { $speechSynth.SelectVoice([string]$speechRequest.voice) }
        $speechSynth.Rate = [Math]::Max(-5, [Math]::Min(5, [int]$speechRequest.rate))
        $speechSynth.SetOutputToWaveFile([string]$speechRequest.output)
        $speechSynth.Speak([string]$speechRequest.text)
        $speechSynth.SetOutputToNull()
        '{"ok":true}'
    }
} finally { $speechSynth.Dispose() }
