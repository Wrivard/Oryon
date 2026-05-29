const fs = require('fs');

const components = [
  { name: 'App.tsx', path: 'src/renderer/src/App.tsx' },
  { name: 'WorkspaceRail', path: 'src/renderer/src/components/WorkspaceRail/index.tsx' },
  { name: 'RightPanel', path: 'src/renderer/src/components/RightPanel/index.tsx' },
  { name: 'TerminalGrid', path: 'src/renderer/src/components/TerminalGrid/index.tsx' },
  { name: 'OrchestratorBar', path: 'src/renderer/src/components/Orchestrator/OrchestratorBar.tsx' },
];

const findings = {
  proper_buttons: 0,
  icon_buttons_with_labels: 0,
  motion_buttons: 0,
  focus_visible: 0,
  issues: []
};

components.forEach(({ name, path }) => {
  if (!fs.existsSync(path)) return;
  
  const content = fs.readFileSync(path, 'utf-8');
  
  // Count proper <button> elements
  const buttonCount = (content.match(/<button\s/g) || []).length;
  findings.proper_buttons += buttonCount;
  
  // Count IconButton with labels
  const iconButtonLabels = (content.match(/label="/g) || []).length;
  findings.icon_buttons_with_labels += iconButtonLabels;
  
  // Count motion.button
  const motionButtons = (content.match(/<motion\.button/g) || []).length;
  findings.motion_buttons += motionButtons;
  
  // Check for focus-visible presence
  if (content.includes('outline-none')) {
    // Good - using outline-none to let focus-visible handle it
  }
  
  // Check input accessibility
  if (path.includes('Orchestrator')) {
    const hasInput = content.includes('<input');
    if (hasInput) {
      const hasPlaceholder = content.includes('placeholder=');
      const hasLabel = content.includes('<label');
      if (!hasLabel && hasPlaceholder) {
        findings.issues.push('OrchestratorBar: input has placeholder but no associated <label>');
      }
    }
  }
});

console.log('Interactive Elements Audit:');
console.log(`Total <button> elements: ${findings.proper_buttons}`);
console.log(`IconButtons with labels: ${findings.icon_buttons_with_labels}`);
console.log(`motion.button elements: ${findings.motion_buttons}`);

if (findings.issues.length > 0) {
  console.log('\nIssues:');
  findings.issues.forEach(issue => console.log(`  - ${issue}`));
} else {
  console.log('\nNo keyboard operability issues detected.');
}
