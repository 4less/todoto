// Palette for whiteboard nodes. Notes are their own coloured surface, so the
// swatches are fixed pastels with dark ink rather than theme variables — they
// read the same in light and dark mode, like real sticky notes on a wall.

export interface BoardColor {
  key: string;
  label: string;
  fill: string;   // sticky-note body / rectangle tint
  border: string; // rectangle outline, sticky-note edge
  ink: string;    // text colour on top of `fill`
}

export const BOARD_COLORS: BoardColor[] = [
  { key: 'yellow', label: 'Yellow', fill: '#fde68a', border: '#d9a441', ink: '#3b2f0b' },
  { key: 'pink',   label: 'Pink',   fill: '#fbcfe8', border: '#db83b0', ink: '#4a1436' },
  { key: 'blue',   label: 'Blue',   fill: '#bfdbfe', border: '#6aa2e8', ink: '#12305e' },
  { key: 'green',  label: 'Green',  fill: '#bbf7d0', border: '#5fbd85', ink: '#0f3d24' },
  { key: 'purple', label: 'Purple', fill: '#ddd6fe', border: '#9b8bea', ink: '#2e1c63' },
  { key: 'orange', label: 'Orange', fill: '#fed7aa', border: '#e79a52', ink: '#4a2408' },
  { key: 'gray',   label: 'Gray',   fill: '#e2e8f0', border: '#94a3b8', ink: '#1e293b' },
];

export const DEFAULT_STICKY_COLOR = 'yellow';
export const DEFAULT_RECT_COLOR = 'blue';

export function boardColor(key: string): BoardColor {
  return BOARD_COLORS.find((c) => c.key === key) ?? BOARD_COLORS[0];
}
