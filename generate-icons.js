// Run with: node generate-icons.js
// Requires: npm install canvas

const { createCanvas } = require('canvas');
const fs = require('fs');

function createIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx    = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0f3460';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.18);
  ctx.fill();

  // Hockey puck emoji style: draw a simple puck + stick
  ctx.fillStyle = '#a0cfff';
  ctx.font      = `bold ${Math.round(size * 0.65)}px serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🏒', size / 2, size / 2);

  return canvas.toBuffer('image/png');
}

[16, 48, 128].forEach(size => {
  fs.writeFileSync(`icon${size}.png`, createIcon(size));
  console.log(`Created icon${size}.png`);
});
