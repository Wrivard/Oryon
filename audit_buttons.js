const fs = require('fs');
const path = require('path');

// Read the component files
const files = [
  'src/renderer/src/App.tsx',
  'src/renderer/src/components/WorkspaceRail/index.tsx',
  'src/renderer/src/components/RightPanel/index.tsx',
  'src/renderer/src/components/Orchestrator/OrchestratorBar.tsx',
  'src/renderer/src/components/TerminalGrid/index.tsx',
];

const issues = [];

files.forEach(filepath => {
  if (!fs.existsSync(filepath)) return;
  
  const content = fs.readFileSync(filepath, 'utf-8');
  
  // Find all IconButton instances
  const iconButtonPattern = /<IconButton\s+(?:[^>]*\n?)*?>/g;
  const matches = content.matchAll(iconButtonPattern);
  
  for (const match of matches) {
    const buttonText = match[0];
    const hasLabel = buttonText.includes('label=');
    const lineNum = content.substring(0, match.index).split('\n').length;
    
    if (!hasLabel) {
      issues.push({
        file: filepath,
        line: lineNum,
        issue: 'IconButton missing required "label" prop',
        code: buttonText.substring(0, 60)
      });
    }
  }
  
  // Find all <button> elements (not <motion.button>)
  const buttonPattern = /<button\s+([^>]*?)>/g;
  const btnMatches = content.matchAll(buttonPattern);
  
  for (const match of btnMatches) {
    const attrs = match[1];
    const fullBtn = match[0];
    const lineNum = content.substring(0, match.index).split('\n').length;
    
    // Check if it's a motion.button
    if (fullBtn.includes('motion.button')) continue;
    
    // Check if button has aria-label or text content nearby
    const hasAriaLabel = attrs.includes('aria-label');
    const hasDisabled = attrs.includes('disabled');
    
    // Get context around button
    const startIdx = Math.max(0, match.index - 100);
    const endIdx = Math.min(content.length, match.index + 200);
    const context = content.substring(startIdx, endIdx);
    
    // Check for text content or aria-label
    if (!hasAriaLabel && !context.includes('>') && fullBtn.match(/class=.*icon/)) {
      // Might be icon-only button
    }
  }
});

if (issues.length > 0) {
  console.log('ACCESSIBILITY ISSUES FOUND:\n');
  issues.forEach(issue => {
    console.log(`${issue.file}:${issue.line}`);
    console.log(`  ${issue.issue}`);
    console.log(`  ${issue.code}\n`);
  });
} else {
  console.log('No obvious accessibility issues with button labels detected.');
}
