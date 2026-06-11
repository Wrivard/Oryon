@echo off
REM ============================================================
REM  Oryon - lanceur DEV PERMANENT (electron-vite, depuis les SOURCES).
REM
REM  INDEPENDANT de l'app installee : tourne depuis CE repo, donc il ne
REM  casse PAS quand l'app se met a jour automatiquement (contrairement a
REM  un raccourci qui pointait vers l'app installee/auto-updatee).
REM
REM  USAGE : FERME d'abord toute fenetre Oryon Dev ouverte, puis double-clique
REM  ce fichier. Ctrl+C ou fermer la fenetre pour stopper.
REM ============================================================
title Oryon DEV (electron-vite)
cd /d "C:\Users\Kolyxe\Desktop\ide"
echo [Oryon dev] Repo : %CD%

REM --- Purge du cache d'affichage Chromium AVANT le lancement -------------------
REM  Un cache corrompu (ex. apres un kill brutal du process) provoque un ECRAN NOIR
REM  malgre un renderer charge ("entry_impl.cc ... No file for ..."). On le purge :
REM  sans danger (Chromique le regenere), ne touche NI oryon.db NI les settings.
REM  Requiert l'app FERMEE (fichiers verrouilles sinon) -> ferme-la avant de lancer.
echo [Oryon dev] Purge du cache d'affichage Chromium...
rmdir /s /q "%APPDATA%\Oryon Dev\Cache" 2>nul
rmdir /s /q "%APPDATA%\Oryon Dev\GPUCache" 2>nul
rmdir /s /q "%APPDATA%\Oryon Dev\Code Cache" 2>nul
rmdir /s /q "%APPDATA%\Oryon Dev\DawnGraphiteCache" 2>nul
rmdir /s /q "%APPDATA%\Oryon Dev\DawnWebGPUCache" 2>nul
rmdir /s /q "%APPDATA%\Oryon Dev\GrShaderCache" 2>nul

REM  NOTE : le "prompt fantome" (npm/run auto-soumis aux agents) etait une CORRUPTION
REM  D'ARGV (les guillemets internes du role-prompt, inline via $(Get-Content), cassaient
REM  la ligne de commande du natif claude.exe -> un fragment devenait un [prompt] positionnel
REM  soumis tout seul). Corrige A LA RACINE dans claude-launcher (--append-system-prompt-file).
REM  L'ancienne "isolation de console" n'est plus necessaire (ce n'etait pas du typeahead).
echo [Oryon dev] La fenetre de l'app dev apparait dans ~10-20s. HMR actif.
echo.
start "Oryon DEV (electron-vite)" /WAIT cmd /c "npm run dev"
echo.
echo [Oryon dev] Le process dev s'est arrete (code %ERRORLEVEL%).
echo [Oryon dev] Si c'est une erreur de module natif, lance d'abord : npm install
pause
