// Intégration shell (Phase 5, command-blocks). On injecte dans PowerShell une fonction `prompt` qui émet
// les séquences sémantiques OSC 133 (standard FinalTerm/iTerm2/VS Code) :
//   OSC 133;A  → début de prompt (ligne de commande)   OSC 133;B → fin de prompt / début de saisie
//   OSC 133;D;<exit> → commande précédente terminée (avec code de sortie)
// Le renderer (xterm) parse ces marqueurs pour décorer chaque commande (pastille exit-code + timestamp).
// Ne s'applique PAS pendant le TUI claude (plein écran, pas de prompt) — uniquement aux commandes shell.
//
// Passé via -EncodedCommand (base64 UTF-16LE) → aucun souci de quoting ; -NoExit garde le shell interactif.

const PS_INTEGRATION = [
  '$e=[char]27;$b=[char]7',
  'function global:prompt {',
  '  $c=$LASTEXITCODE; if($null -eq $c){ if($?){$c=0}else{$c=1} }',
  "  \"$e]133;D;$c$b\" + \"$e]133;A$b\" + ('PS ' + (Get-Location).Path + '> ') + \"$e]133;B$b\"",
  '}',
].join('\n')

/** Args de spawn ajoutant l'intégration shell, selon le shell. Vide si non supporté (ex. bash). */
export function shellIntegrationArgs(shell: string): string[] {
  if (/powershell|pwsh/i.test(shell)) {
    const encoded = Buffer.from(PS_INTEGRATION, 'utf16le').toString('base64')
    return ['-NoExit', '-EncodedCommand', encoded]
  }
  return []
}
