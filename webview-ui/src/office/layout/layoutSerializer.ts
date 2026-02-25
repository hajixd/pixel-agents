import { TileType, FurnitureType, DEFAULT_COLS, DEFAULT_ROWS, TILE_SIZE, Direction } from '../types.js'
import type { TileType as TileTypeVal, OfficeLayout, PlacedFurniture, Seat, FurnitureInstance, FloorColor } from '../types.js'
import { getCatalogEntry } from './furnitureCatalog.js'
import { getColorizedSprite } from '../colorize.js'

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
  // Pre-compute desk zY per tile so surface items can sort in front of desks
  const deskZByTile = new Map<string, number>()
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry || !entry.isDesk) continue
    const deskZY = item.row * TILE_SIZE + entry.sprite.length
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`
        const prev = deskZByTile.get(key)
        if (prev === undefined || deskZY > prev) deskZByTile.set(key, deskZY)
      }
    }
  }

  const instances: FurnitureInstance[] = []
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry) continue
    const x = item.col * TILE_SIZE
    const y = item.row * TILE_SIZE
    const spriteH = entry.sprite.length
    let zY = y + spriteH

    // Chair z-sorting: ensure characters sitting on chairs render correctly
    if (entry.category === 'chairs') {
      if (entry.orientation === 'back') {
        // Back-facing chairs render IN FRONT of the seated character
        // (the chair back visually occludes the character behind it)
        zY = (item.row + 1) * TILE_SIZE + 1
      } else {
        // All other chairs: cap zY to first row bottom so characters
        // at any seat tile render in front of the chair
        zY = (item.row + 1) * TILE_SIZE
      }
    }

    // Surface items render in front of the desk they sit on
    if (entry.canPlaceOnSurfaces) {
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          const deskZ = deskZByTile.get(`${item.col + dc},${item.row + dr}`)
          if (deskZ !== undefined && deskZ + 0.5 > zY) zY = deskZ + 0.5
        }
      }
    }

    // Colorize sprite if this furniture has a color override
    let sprite = entry.sprite
    if (item.color) {
      const { h, s, b: bv, c: cv } = item.color
      sprite = getColorizedSprite(`furn-${item.type}-${h}-${s}-${bv}-${cv}-${item.color.colorize ? 1 : 0}`, entry.sprite, item.color)
    }

    instances.push({ sprite, x, y, zY })
  }
  return instances
}

/** Get all tiles blocked by furniture footprints, optionally excluding a set of tiles.
 *  Skips top backgroundTiles rows so characters can walk through them. */
export function getBlockedTiles(furniture: PlacedFurniture[], excludeTiles?: Set<string>): Set<string> {
  const tiles = new Set<string>()
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry) continue
    const bgRows = entry.backgroundTiles || 0
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue // skip background rows — characters can walk through
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`
        if (excludeTiles && excludeTiles.has(key)) continue
        tiles.add(key)
      }
    }
  }
  return tiles
}

/** Get tiles blocked for placement purposes — skips top backgroundTiles rows per item */
export function getPlacementBlockedTiles(furniture: PlacedFurniture[], excludeUid?: string): Set<string> {
  const tiles = new Set<string>()
  for (const item of furniture) {
    if (item.uid === excludeUid) continue
    const entry = getCatalogEntry(item.type)
    if (!entry) continue
    const bgRows = entry.backgroundTiles || 0
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue // skip background rows
      for (let dc = 0; dc < entry.footprintW; dc++) {
        tiles.add(`${item.col + dc},${item.row + dr}`)
      }
    }
  }
  return tiles
}

/** Map chair orientation to character facing direction */
function orientationToFacing(orientation: string): Direction {
  switch (orientation) {
    case 'front': return Direction.DOWN
    case 'back': return Direction.UP
    case 'left': return Direction.LEFT
    case 'right': return Direction.RIGHT
    default: return Direction.DOWN
  }
}

/** Generate seats from chair furniture.
 *  Facing priority: 1) chair orientation, 2) adjacent desk, 3) forward (DOWN). */
export function layoutToSeats(furniture: PlacedFurniture[]): Map<string, Seat> {
  const seats = new Map<string, Seat>()

  // Build set of all desk tiles
  const deskTiles = new Set<string>()
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry || !entry.isDesk) continue
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        deskTiles.add(`${item.col + dc},${item.row + dr}`)
      }
    }
  }

  const dirs: Array<{ dc: number; dr: number; facing: Direction }> = [
    { dc: 0, dr: -1, facing: Direction.UP },    // desk is above chair → face UP
    { dc: 0, dr: 1, facing: Direction.DOWN },   // desk is below chair → face DOWN
    { dc: -1, dr: 0, facing: Direction.LEFT },   // desk is left of chair → face LEFT
    { dc: 1, dr: 0, facing: Direction.RIGHT },   // desk is right of chair → face RIGHT
  ]

  // For each chair, every footprint tile becomes a seat.
  // Multi-tile chairs (e.g. 2-tile couches) produce multiple seats.
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry || entry.category !== 'chairs') continue

    let seatCount = 0
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const tileCol = item.col + dc
        const tileRow = item.row + dr

        // Determine facing direction:
        // 1) Chair orientation takes priority
        // 2) Adjacent desk direction
        // 3) Default forward (DOWN)
        let facingDir: Direction = Direction.DOWN
        if (entry.orientation) {
          facingDir = orientationToFacing(entry.orientation)
        } else {
          for (const d of dirs) {
            if (deskTiles.has(`${tileCol + d.dc},${tileRow + d.dr}`)) {
              facingDir = d.facing
              break
            }
          }
        }

        // First seat uses chair uid (backward compat), subsequent use uid:N
        const seatUid = seatCount === 0 ? item.uid : `${item.uid}:${seatCount}`
        seats.set(seatUid, {
          uid: seatUid,
          seatCol: tileCol,
          seatRow: tileRow,
          facingDir,
          assigned: false,
        })
        seatCount++
      }
    }
  }

  return seats
}

/** Get the set of tiles occupied by seats (so they can be excluded from blocked tiles) */
export function getSeatTiles(seats: Map<string, Seat>): Set<string> {
  const tiles = new Set<string>()
  for (const seat of seats.values()) {
    tiles.add(`${seat.seatCol},${seat.seatRow}`)
  }
  return tiles
}

/** Default floor colors for the larger multi-room office */
const DEFAULT_LEFT_NORTH_COLOR: FloorColor = { h: 36, s: 32, b: 16, c: 0 }   // warm oak
const DEFAULT_LEFT_MID_COLOR: FloorColor = { h: 26, s: 38, b: 10, c: 4 }     // walnut
const DEFAULT_LEFT_SOUTH_COLOR: FloorColor = { h: 202, s: 20, b: -4, c: 2 }  // cool slate
const DEFAULT_CENTER_NORTH_COLOR: FloorColor = { h: 208, s: 18, b: 6, c: 0 } // meeting space
const DEFAULT_CENTER_SOUTH_COLOR: FloorColor = { h: 198, s: 14, b: -2, c: 1 } // operations
const DEFAULT_RIGHT_NORTH_COLOR: FloorColor = { h: 18, s: 40, b: 10, c: 5 }  // engineering warm
const DEFAULT_RIGHT_MID_COLOR: FloorColor = { h: 214, s: 24, b: 2, c: 0 }    // design cool
const DEFAULT_RIGHT_SOUTH_COLOR: FloorColor = { h: 164, s: 20, b: -8, c: 2 } // lab green
const DEFAULT_CORRIDOR_COLOR: FloorColor = { h: 44, s: 18, b: 18, c: 0 }     // corridor stripe

/** Create the default office layout matching the current hardcoded office */
export function createDefaultLayout(): OfficeLayout {
  const W = TileType.WALL
  const F1 = TileType.FLOOR_1
  const F2 = TileType.FLOOR_2
  const F3 = TileType.FLOOR_3
  const F4 = TileType.FLOOR_4
  const F5 = TileType.FLOOR_5
  const F6 = TileType.FLOOR_6
  const F7 = TileType.FLOOR_7

  const tiles: TileTypeVal[] = []
  const tileColors: Array<FloorColor | null> = []

  const isDoorRow = (row: number, openRanges: Array<[number, number]>): boolean =>
    openRanges.some(([start, end]) => row >= start && row <= end)

  const isDoorCol = (col: number, openRanges: Array<[number, number]>): boolean =>
    openRanges.some(([start, end]) => col >= start && col <= end)

  for (let r = 0; r < DEFAULT_ROWS; r++) {
    for (let c = 0; c < DEFAULT_COLS; c++) {
      if (r === 0 || r === DEFAULT_ROWS - 1 || c === 0 || c === DEFAULT_COLS - 1) {
        tiles.push(W)
        tileColors.push(null)
        continue
      }

      const isVerticalWestWall = c === 16 && !isDoorRow(r, [[6, 8], [12, 13], [22, 24]])
      const isVerticalEastWall = c === 32 && !isDoorRow(r, [[5, 7], [14, 16], [21, 23]])
      const isCenterHorizontalWall = r === 15 && c >= 16 && c <= 32 && !isDoorCol(c, [[23, 25]])
      const isLeftMeetingWall = r === 10 && c >= 1 && c <= 15 && !isDoorCol(c, [[7, 8]])
      const isRightLabWall = r === 20 && c >= 33 && c <= DEFAULT_COLS - 2 && !isDoorCol(c, [[39, 40]])

      if (isVerticalWestWall || isVerticalEastWall || isCenterHorizontalWall || isLeftMeetingWall || isRightLabWall) {
        tiles.push(W)
        tileColors.push(null)
        continue
      }

      if (c >= 22 && c <= 26) {
        tiles.push(F6)
        tileColors.push(DEFAULT_CORRIDOR_COLOR)
        continue
      }

      if (c < 16) {
        if (r < 10) {
          tiles.push(F1)
          tileColors.push(DEFAULT_LEFT_NORTH_COLOR)
        } else if (r < 20) {
          tiles.push(F2)
          tileColors.push(DEFAULT_LEFT_MID_COLOR)
        } else {
          tiles.push(F3)
          tileColors.push(DEFAULT_LEFT_SOUTH_COLOR)
        }
        continue
      }

      if (c > 32) {
        if (r < 12) {
          tiles.push(F2)
          tileColors.push(DEFAULT_RIGHT_NORTH_COLOR)
        } else if (r < 20) {
          tiles.push(F3)
          tileColors.push(DEFAULT_RIGHT_MID_COLOR)
        } else {
          tiles.push(F4)
          tileColors.push(DEFAULT_RIGHT_SOUTH_COLOR)
        }
        continue
      }

      if (r < 15) {
        tiles.push(F5)
        tileColors.push(DEFAULT_CENTER_NORTH_COLOR)
      } else {
        tiles.push(F7)
        tileColors.push(DEFAULT_CENTER_SOUTH_COLOR)
      }
    }
  }

  const furniture: PlacedFurniture[] = []

  const addDeskCluster = (idPrefix: string, col: number, row: number): void => {
    furniture.push({ uid: `${idPrefix}-desk`, type: FurnitureType.DESK, col, row })
    furniture.push({ uid: `${idPrefix}-chair-top`, type: FurnitureType.CHAIR, col, row: row - 1 })
    furniture.push({ uid: `${idPrefix}-chair-bottom`, type: FurnitureType.CHAIR, col: col + 1, row: row + 2 })
    furniture.push({ uid: `${idPrefix}-chair-left`, type: FurnitureType.CHAIR, col: col - 1, row: row + 1 })
    furniture.push({ uid: `${idPrefix}-chair-right`, type: FurnitureType.CHAIR, col: col + 2, row })
  }

  // Left wing
  addDeskCluster('left-nw-1', 3, 3)
  addDeskCluster('left-nw-2', 9, 3)
  addDeskCluster('left-mid-1', 3, 13)
  addDeskCluster('left-mid-2', 9, 13)
  addDeskCluster('left-sw-1', 3, 23)
  addDeskCluster('left-sw-2', 9, 23)

  // Center wing
  addDeskCluster('center-n-1', 18, 4)
  addDeskCluster('center-n-2', 28, 4)
  addDeskCluster('center-n-3', 18, 9)
  addDeskCluster('center-n-4', 28, 9)
  addDeskCluster('center-s-1', 18, 19)
  addDeskCluster('center-s-2', 28, 19)
  addDeskCluster('center-s-3', 18, 24)
  addDeskCluster('center-s-4', 28, 24)

  // Right wing
  addDeskCluster('right-ne-1', 35, 4)
  addDeskCluster('right-ne-2', 41, 4)
  addDeskCluster('right-mid-1', 35, 13)
  addDeskCluster('right-mid-2', 41, 13)
  addDeskCluster('right-se-1', 36, 23)
  addDeskCluster('right-se-2', 42, 23)

  furniture.push(
    { uid: 'bookshelf-west-1', type: FurnitureType.BOOKSHELF, col: 1, row: 4 },
    { uid: 'bookshelf-west-2', type: FurnitureType.BOOKSHELF, col: 1, row: 14 },
    { uid: 'bookshelf-west-3', type: FurnitureType.BOOKSHELF, col: 1, row: 24 },
    { uid: 'bookshelf-east-1', type: FurnitureType.BOOKSHELF, col: 46, row: 4 },
    { uid: 'bookshelf-east-2', type: FurnitureType.BOOKSHELF, col: 46, row: 13 },
    { uid: 'bookshelf-east-3', type: FurnitureType.BOOKSHELF, col: 46, row: 24 },
    { uid: 'cooler-center-north', type: FurnitureType.COOLER, col: 24, row: 2 },
    { uid: 'cooler-center-south', type: FurnitureType.COOLER, col: 24, row: 26 },
    { uid: 'plant-west-1', type: FurnitureType.PLANT, col: 2, row: 1 },
    { uid: 'plant-west-2', type: FurnitureType.PLANT, col: 14, row: 28 },
    { uid: 'plant-center-1', type: FurnitureType.PLANT, col: 17, row: 1 },
    { uid: 'plant-center-2', type: FurnitureType.PLANT, col: 31, row: 28 },
    { uid: 'plant-east-1', type: FurnitureType.PLANT, col: 34, row: 1 },
    { uid: 'plant-east-2', type: FurnitureType.PLANT, col: 45, row: 28 },
    { uid: 'whiteboard-1', type: FurnitureType.WHITEBOARD, col: 5, row: 0 },
    { uid: 'whiteboard-2', type: FurnitureType.WHITEBOARD, col: 22, row: 0 },
    { uid: 'whiteboard-3', type: FurnitureType.WHITEBOARD, col: 38, row: 0 },
  )

  return { version: 1, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, tiles, tileColors, furniture }
}

/** Serialize layout to JSON string */
export function serializeLayout(layout: OfficeLayout): string {
  return JSON.stringify(layout)
}

/** Deserialize layout from JSON string, migrating old tile types if needed */
export function deserializeLayout(json: string): OfficeLayout | null {
  try {
    const obj = JSON.parse(json)
    if (obj && obj.version === 1 && Array.isArray(obj.tiles) && Array.isArray(obj.furniture)) {
      return migrateLayout(obj as OfficeLayout)
    }
  } catch { /* ignore parse errors */ }
  return null
}

/**
 * Ensure layout has tileColors. If missing, generate defaults based on tile types.
 * Exported for use by message handlers that receive layouts over the wire.
 */
export function migrateLayoutColors(layout: OfficeLayout): OfficeLayout {
  return migrateLayout(layout)
}

/**
 * Migrate old layouts that use legacy tile types (TILE_FLOOR=1, WOOD_FLOOR=2, CARPET=3, DOORWAY=4)
 * to the new pattern-based system. If tileColors is already present, no migration needed.
 */
function migrateLayout(layout: OfficeLayout): OfficeLayout {
  if (layout.tileColors && layout.tileColors.length === layout.tiles.length) {
    return layout // Already migrated
  }

  // Check if any tiles use old values (1-4) — these map directly to FLOOR_1-4
  // but need color assignments
  const tileColors: Array<FloorColor | null> = []
  for (const tile of layout.tiles) {
    switch (tile) {
      case 0: // WALL
        tileColors.push(null)
        break
      case 1: // was TILE_FLOOR → FLOOR_1 beige
        tileColors.push(DEFAULT_LEFT_NORTH_COLOR)
        break
      case 2: // was WOOD_FLOOR → FLOOR_2 brown
        tileColors.push(DEFAULT_RIGHT_NORTH_COLOR)
        break
      case 3: // was CARPET → FLOOR_3 purple
        tileColors.push(DEFAULT_RIGHT_MID_COLOR)
        break
      case 4: // was DOORWAY → FLOOR_4 tan
        tileColors.push(DEFAULT_CORRIDOR_COLOR)
        break
      default:
        // New tile types (5-7) without colors — use neutral gray
        tileColors.push(tile > 0 ? { h: 0, s: 0, b: 0, c: 0 } : null)
    }
  }

  return { ...layout, tileColors }
}
