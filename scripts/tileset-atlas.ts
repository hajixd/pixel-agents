/**
 * Atlas configuration for the Donarg Office Tileset (16x16 grid).
 * Each entry maps a grid region to a named sprite for use in the furniture catalog.
 *
 * Coordinates are in tile units (fractional allowed — multiplied by 16 to get pixels).
 * Curated manually using scripts/atlas-editor.html.
 */

export interface AtlasEntry {
  name: string
  label: string
  col: number
  row: number
  w: number
  h: number
  footprintW: number
  footprintH: number
  isDesk: boolean
  category: 'desks' | 'chairs' | 'storage' | 'decor' | 'electronics' | 'misc'
}

export const ATLAS_ENTRIES: AtlasEntry[] = [
  // Desks
  { name: 'TABLE_WOOD_SM_VERTICAL', label: 'Wood Table Vertical', col: 1, row: 17.94, w: 1, h: 2, footprintW: 1, footprintH: 2, isDesk: true, category: 'desks' },

  // Chairs
  { name: 'CHAIR_CUSHION', label: 'Cushioned Chair', col: 0, row: 16.13, w: 4, h: 1, footprintW: 4, footprintH: 1, isDesk: false, category: 'chairs' },
  { name: 'CHAIR_SPINNING', label: 'Spinning Chair', col: 4, row: 16.13, w: 4, h: 1, footprintW: 4, footprintH: 1, isDesk: false, category: 'chairs' },
  { name: 'BENCH', label: 'Bench', col: 0, row: 18.19, w: 1, h: 1, footprintW: 1, footprintH: 1, isDesk: false, category: 'chairs' },

  // Decor
  { name: 'WATER_COOLER', label: 'Water Cooler', col: 8.88, row: 16.44, w: 1, h: 2, footprintW: 1, footprintH: 2, isDesk: false, category: 'decor' },
  { name: 'FRIDGE', label: 'Fridge', col: 12, row: 16.44, w: 1, h: 2, footprintW: 1, footprintH: 2, isDesk: false, category: 'decor' },
  { name: 'DECO_3', label: 'DECO 3', col: 14, row: 16.44, w: 2, h: 2, footprintW: 2, footprintH: 2, isDesk: false, category: 'decor' },
  { name: 'CLOCK', label: 'Clock', col: 0, row: 22.69, w: 1, h: 1, footprintW: 1, footprintH: 1, isDesk: false, category: 'decor' },
  { name: 'LIBRARY_GRAY_FULL', label: 'Library Gray Full', col: 13, row: 8.44, w: 2, h: 2, footprintW: 2, footprintH: 2, isDesk: false, category: 'decor' },
  { name: 'PLANT_SMALL', label: 'Small Plant', col: 2, row: 28.38, w: 1, h: 1, footprintW: 1, footprintH: 1, isDesk: false, category: 'decor' },
  { name: 'PAINTING_LARGE_1', label: 'Painting Large 1', col: 0, row: 24.69, w: 2, h: 1, footprintW: 2, footprintH: 1, isDesk: false, category: 'decor' },
  { name: 'PAINTING_LARGE_2', label: 'Painting Large 2', col: 2, row: 24.69, w: 2, h: 1, footprintW: 2, footprintH: 1, isDesk: false, category: 'decor' },
  { name: 'PAINTING_SMALL_1', label: 'Painting Small 1', col: 4, row: 24.69, w: 1, h: 1, footprintW: 1, footprintH: 1, isDesk: false, category: 'decor' },
  { name: 'PAINTING_SMALL_2', label: 'Painting Small 2', col: 5, row: 24.69, w: 1, h: 1, footprintW: 1, footprintH: 1, isDesk: false, category: 'decor' },
  { name: 'PAINTING_SMALL_3', label: 'Painting Small 3', col: 6, row: 24.69, w: 1, h: 1, footprintW: 1, footprintH: 1, isDesk: false, category: 'decor' },
]
