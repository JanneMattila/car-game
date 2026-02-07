// Car colors

import { CarColor } from '../types/player';

export interface ColorDefinition {
  name: string;
  hex: string;
  rgb: { r: number; g: number; b: number };
  tint: number;
}

export const CAR_COLORS: Record<CarColor, ColorDefinition> = {
  red: {
    name: 'Racing Red',
    hex: '#DC2626',
    rgb: { r: 220, g: 38, b: 38 },
    tint: 0xdc2626,
  },
  blue: {
    name: 'Midnight Blue',
    hex: '#1E40AF',
    rgb: { r: 30, g: 64, b: 175 },
    tint: 0x1e40af,
  },
  black: {
    name: 'Jet Black',
    hex: '#171717',
    rgb: { r: 23, g: 23, b: 23 },
    tint: 0x171717,
  },
  white: {
    name: 'Pearl White',
    hex: '#F5F5F4',
    rgb: { r: 245, g: 245, b: 244 },
    tint: 0xf5f5f4,
  },
  silver: {
    name: 'Silver',
    hex: '#9CA3AF',
    rgb: { r: 156, g: 163, b: 175 },
    tint: 0x9ca3af,
  },
  green: {
    name: 'Forest Green',
    hex: '#15803D',
    rgb: { r: 21, g: 128, b: 61 },
    tint: 0x15803d,
  },
  yellow: {
    name: 'Sunburst Yellow',
    hex: '#EAB308',
    rgb: { r: 234, g: 179, b: 8 },
    tint: 0xeab308,
  },
  orange: {
    name: 'Burnt Orange',
    hex: '#EA580C',
    rgb: { r: 234, g: 88, b: 12 },
    tint: 0xea580c,
  },
};

export const COLOR_ORDER: CarColor[] = [
  'red',
  'blue',
  'black',
  'white',
  'silver',
  'green',
  'yellow',
  'orange',
];

export function getAvailableColor(usedColors: CarColor[]): CarColor | null {
  for (const color of COLOR_ORDER) {
    if (!usedColors.includes(color)) {
      return color;
    }
  }
  return null;
}

export function getColorHex(color: CarColor): string {
  return CAR_COLORS[color].hex;
}

export function getColorTint(color: CarColor): number {
  return CAR_COLORS[color].tint;
}
