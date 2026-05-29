// Intégration shell (Phase 5, command-blocks). On injecte dans PowerShell une fonction `prompt` qui émet
// les séquences sémantiques OSC 133 (standard FinalTerm/iTerm2/VS Code) :
//   OSC 133;A  → début de prompt (ligne de commande)   OSC 133;B → fin de prompt / début de saisie
//   OSC 133;D;<exit> → commande précédente terminée (avec code de sortie)
// Le renderer (xterm) parse ces marqueurs pour décorer chaque commande (pastille exit-code + timestamp).
// Ne s'applique PAS pendant le TUI claude (plein écran, pas de prompt) — uniquement aux commandes shell.
//
// Passé via -EncodedCommand (base64 UTF-16LE) → aucun souci de quoting ; -NoExit garde le shell interactif.

const PS_INTEGRATION = [
  // Garde-fou coût $0 : ré-efface ANTHROPIC_API_KEY au cas où un $PROFILE la ré-injecterait (s'exécute APRÈS
  // le profil via -EncodedCommand → gagne). -NoProfile (cf. args) évite déjà le profil ; ceci est ceinture+bretelles.
  'Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue',
  '$e=[char]27;$b=[char]7',
  'function global:prompt {',
  '  $c=$LASTEXITCODE; if($null -eq $c){ if($?){$c=0}else{$c=1} }',
  "  \"$e]133;D;$c$b\" + \"$e]133;A$b\" + ('PS ' + (Get-Location).Path + '> ') + \"$e]133;B$b\"",
  '}',
].join('\n')

/**
 * Args de spawn ajoutant l'intégration shell. -NoProfile est CRITIQUE ($0) : sans lui, le $PROFILE de
 * l'utilisateur tourne dans le PTY APRÈS qu'on ait retiré ANTHROPIC_API_KEY → pourrait la ré-injecter et
 * basculer l'agent sur l'API PAYANTE. Vide (mais cf. baseShellArgs) pour les shells non supportés.
 */
export function shellIntegrationArgs(shell: string): string[] {
  if (/powershell|pwsh/i.test(shell)) {
    const encoded = Buffer.from(PS_INTEGRATION, 'utf16le').toString('base64')
    return ['-NoProfile', '-NoExit', '-EncodedCommand', encoded]
  }
  return []
}

/** Args minimaux quand l'intégration shell est désactivée : garde -NoProfile ($0) pour PowerShell. */
export function baseShellArgs(shell: string): string[] {
  return /powershell|pwsh/i.test(shell) ? ['-NoProfile'] : []
}
