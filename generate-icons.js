// Script para gerar ícones do app via Canvas (sem dependências externas)
// Gera icon.png (512x512) e tray-icon.png (16x16) como SVGs convertidos
const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);

// SVG para o ícone principal
const mainIcon = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#4f46e5"/>
      <stop offset="100%" stop-color="#3730a3"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(255,255,255,0.15)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </linearGradient>
  </defs>
  <!-- Background -->
  <rect width="512" height="512" rx="100" fill="url(#bg)"/>
  <rect width="512" height="256" rx="100" fill="url(#glow)"/>
  <!-- Printer Body -->
  <rect x="120" y="180" width="272" height="160" rx="16" fill="white" opacity="0.95"/>
  <!-- Paper Tray Top -->
  <rect x="156" y="120" width="200" height="80" rx="8" fill="white" opacity="0.7"/>
  <!-- Paper Output -->
  <rect x="156" y="320" width="200" height="80" rx="4" fill="white" opacity="0.6"/>
  <!-- Lines on paper -->
  <rect x="180" y="335" width="120" height="4" rx="2" fill="#4f46e5" opacity="0.4"/>
  <rect x="180" y="348" width="90" height="4" rx="2" fill="#4f46e5" opacity="0.3"/>
  <rect x="180" y="361" width="100" height="4" rx="2" fill="#4f46e5" opacity="0.2"/>
  <!-- Lightning bolt -->
  <path d="M340 130 L310 180 L330 180 L300 230 L350 170 L325 170 L355 130Z" fill="#fbbf24" opacity="0.9"/>
  <!-- Status dot -->
  <circle cx="160" cy="250" r="10" fill="#10b981"/>
</svg>`;

// SVG para o ícone da bandeja (tray)
const trayIcon = `<svg width="16" height="16" xmlns="http://www.w3.org/2000/svg">
  <rect width="16" height="16" rx="3" fill="#4f46e5"/>
  <text x="8" y="12" text-anchor="middle" fill="white" font-size="11" font-family="Arial" font-weight="bold">P</text>
</svg>`;

// Salva como SVG (Electron suporta SVG nativamente em muitos casos)
// Para build real, esses precisam ser convertidos para PNG
fs.writeFileSync(path.join(assetsDir, 'icon.svg'), mainIcon);
fs.writeFileSync(path.join(assetsDir, 'tray-icon.svg'), trayIcon);

// Salva icon.png placeholder (1x1 pixel PNG transparente para não quebrar o build)
// O electron-builder vai usar o SVG ou um PNG real
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
fs.writeFileSync(path.join(assetsDir, 'icon.png'), PNG_1x1);

console.log('✅ Ícones gerados em assets/');
console.log('   - icon.svg (512x512)');
console.log('   - tray-icon.svg (16x16)');
console.log('   - icon.png (placeholder para build)');
console.log('');
console.log('⚠️  Para builds de produção, converta icon.svg para:');
console.log('   - icon.png (512x512) para Windows/Mac');
console.log('   - icon.icns para macOS');
console.log('   - icon.ico para Windows');
