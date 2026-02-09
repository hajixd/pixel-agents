import { TileType, FurnitureType, MAP_COLS, MAP_ROWS, TILE_SIZE, Direction } from '../types.js'
import type { TileType as TileTypeVal, OfficeLayout, PlacedFurniture, DeskSlot, FurnitureInstance } from '../types.js'
import { getCatalogEntry } from './furnitureCatalog.js'

/** Convert flat tile array from layout into 2D grid */
export function layoutToTileMap(layout: OfficeLayout): TileTypeVal[][] {
  const map: TileTypeVal[][] = []
  for (let r = 0; r < layout.rows; r++) {
    const row: TileTypeVal[] = []
    for (let c = 0; c < layout.cols; c++) {
      row.push(layout.tiles[r * layout.cols + c])
    }
    map.push(row)
  }
  return map
}

/** Convert placed furniture into renderable FurnitureInstance[] */
export function layoutToFurnitureInstances(furniture: PlacedFurniture[]): FurnitureInstance[] {
  const instances: FurnitureInstance[] = []
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry) continue
    const x = item.col * TILE_SIZE
    const y = item.row * TILE_SIZE
    const spriteH = entry.sprite.length
    instances.push({
      sprite: entry.sprite,
      x,
      y,
      zY: y + spriteH,
    })
  }
  return instances
}

/** Get all tiles blocked by furniture footprints */
export function getBlockedTiles(furniture: PlacedFurniture[]): Set<string> {
  const tiles = new Set<string>()
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry) continue
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        tiles.add(`${item.col + dc},${item.row + dr}`)
      }
    }
  }
  return tiles
}

/** Generate desk slots from any furniture with isDesk=true */
export function layoutToDeskSlots(furniture: PlacedFurniture[], blockedTiles: Set<string>): DeskSlot[] {
  const slots: DeskSlot[] = []
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry || !entry.isDesk) continue

    const fw = entry.footprintW
    const fh = entry.footprintH

    // Generate chair positions along each edge of the desk
    const candidates: Array<{ chairCol: number; chairRow: number; facingDir: Direction }> = []

    // Top edge: chairs above the desk, facing DOWN
    for (let dc = 0; dc < fw; dc++) {
      candidates.push({ chairCol: item.col + dc, chairRow: item.row - 1, facingDir: Direction.DOWN })
    }
    // Bottom edge: chairs below the desk, facing UP
    for (let dc = 0; dc < fw; dc++) {
      candidates.push({ chairCol: item.col + dc, chairRow: item.row + fh, facingDir: Direction.UP })
    }
    // Left edge: chairs left of desk, facing RIGHT
    for (let dr = 0; dr < fh; dr++) {
      candidates.push({ chairCol: item.col - 1, chairRow: item.row + dr, facingDir: Direction.RIGHT })
    }
    // Right edge: chairs right of desk, facing LEFT
    for (let dr = 0; dr < fh; dr++) {
      candidates.push({ chairCol: item.col + fw, chairRow: item.row + dr, facingDir: Direction.LEFT })
    }

    for (const c of candidates) {
      // Chair tile must be in bounds and not blocked
      if (c.chairCol < 0 || c.chairCol >= MAP_COLS || c.chairRow < 0 || c.chairRow >= MAP_ROWS) continue
      if (blockedTiles.has(`${c.chairCol},${c.chairRow}`)) continue
      slots.push({
        deskCol: item.col,
        deskRow: item.row,
        chairCol: c.chairCol,
        chairRow: c.chairRow,
        facingDir: c.facingDir,
        assigned: false,
      })
    }
  }
  return slots
}

/** Create the default office layout matching the current hardcoded office */
export function createDefaultLayout(): OfficeLayout {
  const W = TileType.WALL
  const T = TileType.TILE_FLOOR
  const F = TileType.WOOD_FLOOR
  const C = TileType.CARPET
  const D = TileType.DOORWAY

  const tiles: TileTypeVal[] = []
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      if (r === 0 || r === MAP_ROWS - 1) { tiles.push(W); continue }
      if (c === 0 || c === MAP_COLS - 1) { tiles.push(W); continue }
      if (c === 10) { tiles.push(r >= 4 && r <= 6 ? D : W); continue }
      if (c >= 15 && c <= 18 && r >= 7 && r <= 9) { tiles.push(C); continue }
      tiles.push(c < 10 ? T : F)
    }
  }

  const furniture: PlacedFurniture[] = [
    { uid: 'desk-left', type: FurnitureType.DESK, col: 4, row: 3 },
    { uid: 'desk-right', type: FurnitureType.DESK, col: 13, row: 3 },
    { uid: 'bookshelf-1', type: FurnitureType.BOOKSHELF, col: 1, row: 5 },
    { uid: 'plant-left', type: FurnitureType.PLANT, col: 1, row: 1 },
    { uid: 'cooler-1', type: FurnitureType.COOLER, col: 17, row: 7 },
    { uid: 'plant-right', type: FurnitureType.PLANT, col: 18, row: 1 },
    { uid: 'whiteboard-1', type: FurnitureType.WHITEBOARD, col: 15, row: 0 },
  ]

  return { version: 1, cols: MAP_COLS, rows: MAP_ROWS, tiles, furniture }
}

/** Serialize layout to JSON string */
export function serializeLayout(layout: OfficeLayout): string {
  return JSON.stringify(layout)
}

/** Deserialize layout from JSON string */
export function deserializeLayout(json: string): OfficeLayout | null {
  try {
    const obj = JSON.parse(json)
    if (obj && obj.version === 1 && Array.isArray(obj.tiles) && Array.isArray(obj.furniture)) {
      return obj as OfficeLayout
    }
  } catch { /* ignore parse errors */ }
  return null
}
