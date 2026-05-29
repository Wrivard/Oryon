function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

function getLuminance(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;

  r = r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
  g = g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
  b = b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getContrast(color1, color2) {
  const c1 = hexToRgb(color1);
  const c2 = hexToRgb(color2);
  
  const lum1 = getLuminance(c1.r, c1.g, c1.b);
  const lum2 = getLuminance(c2.r, c2.g, c2.b);
  
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  
  return (lighter + 0.05) / (darker + 0.05);
}

const colors = {
  bg: '#1b1b1b',
  'bg-deep': '#141414',
  'bg-panel': '#1f1f1f',
  'bg-elevated': '#242424',
  'bg-inset': '#161616',
  fg: '#ededed',
  'fg-muted': '#a0a0a0',
  'fg-subtle': '#6e6e6e',
  accent: '#00e599',
  'accent-hover': '#2bf0ad',
  'accent-active': '#00c885',
  'on-accent': '#08120d',
};

const tests = [
  ['fg', 'bg', 'CRITICAL: Body text (fg) on main bg'],
  ['fg-muted', 'bg', 'CRITICAL: Secondary text (fg-muted) on main bg'],
  ['fg-subtle', 'bg', 'Subtle/hint text (fg-subtle) on main bg'],
  ['fg', 'bg-panel', 'Body text (fg) on bg-panel'],
  ['fg-muted', 'bg-panel', 'Secondary text (fg-muted) on bg-panel'],
  ['fg-subtle', 'bg-panel', 'Subtle text (fg-subtle) on bg-panel'],
  ['fg', 'bg-elevated', 'Body text (fg) on bg-elevated'],
  ['fg-muted', 'bg-elevated', 'Secondary text (fg-muted) on bg-elevated'],
  ['fg-subtle', 'bg-elevated', 'Subtle text (fg-subtle) on bg-elevated'],
  ['on-accent', 'accent', 'CRITICAL: Button text (on-accent) on accent'],
  ['on-accent', 'accent-hover', 'Button text (on-accent) on accent-hover'],
  ['on-accent', 'accent-active', 'Button text (on-accent) on accent-active'],
  ['fg', 'bg-inset', 'Body text (fg) on bg-inset (form field)'],
  ['fg-muted', 'bg-inset', 'Secondary text (fg-muted) on bg-inset'],
  ['fg-subtle', 'bg-inset', 'Subtle text (fg-subtle) on bg-inset'],
];

console.log('WCAG Contrast Ratio Analysis');
console.log('Target: AA normal text = 4.5:1, AA large text = 3:1, AAA = 7:1\n');

const failures = [];

tests.forEach(([fg, bg, desc]) => {
  const ratio = getContrast(colors[fg], colors[bg]);
  let status;
  if (ratio < 3) {
    status = 'FAIL';
    failures.push({ desc, ratio, fg, bg });
  } else if (ratio < 4.5) {
    status = 'WARN';
  } else if (ratio < 7) {
    status = 'PASS';
  } else {
    status = 'AAA';
  }
  
  console.log(`[${status}] ${ratio.toFixed(2)}:1  ${desc}`);
});

if (failures.length > 0) {
  console.log('\n=== ACCESSIBILITY FAILURES ===');
  failures.forEach(({ desc, ratio, fg, bg }) => {
    console.log(`\n${desc}`);
    console.log(`  Ratio: ${ratio.toFixed(2)}:1`);
    console.log(`  FG: ${colors[fg]}, BG: ${colors[bg]}`);
  });
}
