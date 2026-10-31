import fs from 'fs';
import path from 'path';
import { storageService } from './storage.service.js';

class NavigationService {
  constructor() {
    this.cache = new Map(); // projectId -> navgrid data
  }

  getNavGridFilePath(projectId) {
    const id = projectId.toString();
    const paths = storageService.getProjectStoragePaths(id);
    const navDir = path.join(paths.projectStorage, 'navigation');
    if (!fs.existsSync(navDir)) {
      fs.mkdirSync(navDir, { recursive: true });
    }
    return path.join(navDir, 'navgrid.json');
  }

  async getNavGrid(projectId) {
    const id = projectId.toString();
    if (this.cache.has(id)) {
      return this.cache.get(id);
    }

    const filePath = this.getNavGridFilePath(id);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        this.cache.set(id, data);
        return data;
      } catch (e) {
        console.error(`[NavigationService] Failed to parse navgrid.json for project ${id}:`, e);
      }
    }

    // Check if sample scene fallback exists
    if (id === 'sample_digital_twin' || id === 'demo') {
      const demoPath = path.join(
        storageService.storageDir,
        'projects',
        'sample_digital_twin',
        'navigation',
        'navgrid.json'
      );
      if (fs.existsSync(demoPath)) {
        const raw = fs.readFileSync(demoPath, 'utf-8');
        const data = JSON.parse(raw);
        this.cache.set(id, data);
        return data;
      }
    }

    return null;
  }

  saveNavGrid(projectId, navGridData) {
    const id = projectId.toString();
    const filePath = this.getNavGridFilePath(id);
    fs.writeFileSync(filePath, JSON.stringify(navGridData, null, 2), 'utf-8');
    this.cache.set(id, navGridData);
    return filePath;
  }

  clearCache(projectId) {
    if (projectId) {
      this.cache.delete(projectId.toString());
    } else {
      this.cache.clear();
    }
  }

  worldToGrid(x, z, navGrid) {
    const col = Math.floor((x - navGrid.origin[0]) / navGrid.resolution);
    const row = Math.floor((z - navGrid.origin[1]) / navGrid.resolution);
    return { col, row };
  }

  gridToWorld(col, row, navGrid) {
    const x = navGrid.origin[0] + (col + 0.5) * navGrid.resolution;
    const z = navGrid.origin[1] + (row + 0.5) * navGrid.resolution;
    return { x: Number(x.toFixed(3)), z: Number(z.toFixed(3)) };
  }

  inBounds(col, row, navGrid) {
    return col >= 0 && col < navGrid.width && row >= 0 && row < navGrid.height;
  }

  isWalkable(col, row, navGrid) {
    if (!this.inBounds(col, row, navGrid)) return false;
    return navGrid.grid[row][col] === 0;
  }

  snapToWalkable(x, z, navGrid, maxRadiusM = 2.0) {
    const { col: startCol, row: startRow } = this.worldToGrid(x, z, navGrid);
    if (this.isWalkable(startCol, startRow, navGrid)) {
      return { x, z, col: startCol, row: startRow };
    }

    const maxCells = Math.ceil(maxRadiusM / navGrid.resolution);
    let bestDistSq = Infinity;
    let best = null;

    for (let r = 1; r <= maxCells; r++) {
      for (let dr = -r; dr <= r; dr++) {
        for (const dc of [-r, r]) {
          const row = startRow + dr;
          const col = startCol + dc;
          if (this.isWalkable(col, row, navGrid)) {
            const world = this.gridToWorld(col, row, navGrid);
            const dSq = (world.x - x) ** 2 + (world.z - z) ** 2;
            if (dSq < bestDistSq) {
              bestDistSq = dSq;
              best = { x: world.x, z: world.z, col, row };
            }
          }
        }
        for (let dc = -r + 1; dc < r; dc++) {
          for (const drow of [-r, r]) {
            const row = startRow + drow;
            const col = startCol + dc;
            if (this.isWalkable(col, row, navGrid)) {
              const world = this.gridToWorld(col, row, navGrid);
              const dSq = (world.x - x) ** 2 + (world.z - z) ** 2;
              if (dSq < bestDistSq) {
                bestDistSq = dSq;
                best = { x: world.x, z: world.z, col, row };
              }
            }
          }
        }
      }
      if (best) return best;
    }

    return null;
  }

  hasLineOfSight(c0, r0, c1, r1, navGrid) {
    const dx = Math.abs(c1 - c0);
    const dy = Math.abs(r1 - r0);
    let x = c0;
    let y = r0;
    let n = 1 + dx + dy;
    const xInc = c1 > c0 ? 1 : -1;
    const yInc = r1 > r0 ? 1 : -1;
    let error = dx - dy;
    const dx2 = dx * 2;
    const dy2 = dy * 2;

    for (; n > 0; n--) {
      if (!this.isWalkable(x, y, navGrid)) return false;

      if (error > 0) {
        x += xInc;
        error -= dy2;
      } else if (error < 0) {
        y += yInc;
        error += dx2;
      } else {
        if (!this.isWalkable(x + xInc, y, navGrid)) return false;
        if (!this.isWalkable(x, y + yInc, navGrid)) return false;
        x += xInc;
        y += yInc;
        error += dx2 - dy2;
      }

      if (x === c1 && y === r1) {
        return this.isWalkable(x, y, navGrid);
      }
    }
    return true;
  }

  smoothPath(rawWaypoints, navGrid) {
    if (rawWaypoints.length <= 2) return rawWaypoints;

    const smoothed = [rawWaypoints[0]];
    let currentIdx = 0;

    while (currentIdx < rawWaypoints.length - 1) {
      let furthestIdx = rawWaypoints.length - 1;
      let found = false;

      while (furthestIdx > currentIdx + 1) {
        const p0 = rawWaypoints[currentIdx];
        const p1 = rawWaypoints[furthestIdx];
        if (this.hasLineOfSight(p0.col, p0.row, p1.col, p1.row, navGrid)) {
          found = true;
          break;
        }
        furthestIdx--;
      }

      if (found) {
        smoothed.push(rawWaypoints[furthestIdx]);
        currentIdx = furthestIdx;
      } else {
        smoothed.push(rawWaypoints[currentIdx + 1]);
        currentIdx++;
      }
    }

    return smoothed;
  }

  findPath(navGrid, startWorld, goalWorld, options = {}) {
    const walkingSpeedMps = options.walkingSpeedMps || 1.3;
    const metersPerUnit = options.metersPerUnit || 1.0;
    const floorY = options.floorY || 0.0;

    const [sx, sy, sz] = startWorld;
    const [gx, gy, gz] = goalWorld;

    const startSnap = this.snapToWalkable(sx, sz, navGrid);
    const goalSnap = this.snapToWalkable(gx, gz, navGrid);

    if (!startSnap || !goalSnap) {
      return {
        found: false,
        error: 'Start or destination coordinate is outside reachable boundaries',
        path: [],
        distanceMeters: 0,
        walkingEtaSeconds: 0,
        walkingEtaFormatted: '0s',
      };
    }

    if (startSnap.col === goalSnap.col && startSnap.row === goalSnap.row) {
      const directDist = Math.hypot(gx - sx, gz - sz) * metersPerUnit;
      return {
        found: true,
        path: [
          { x: sx, y: sy || floorY, z: sz },
          { x: gx, y: gy || floorY, z: gz },
        ],
        rawWaypointsCount: 2,
        smoothedWaypointsCount: 2,
        distanceMeters: Number(directDist.toFixed(2)),
        walkingSpeedMps,
        walkingEtaSeconds: 1.0,
        walkingEtaFormatted: '1s',
      };
    }

    // Min-heap Priority Queue for A*
    const openSet = new TinyMinHeap();
    const startKey = `${startSnap.col},${startSnap.row}`;
    const goalCol = goalSnap.col;
    const goalRow = goalSnap.row;

    const heuristic = (c, r) => {
      const dx = Math.abs(c - goalCol);
      const dy = Math.abs(r - goalRow);
      return (dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)) * navGrid.resolution;
    };

    const gScore = new Map();
    const cameFrom = new Map();
    gScore.set(startKey, 0);

    const h0 = heuristic(startSnap.col, startSnap.row);
    openSet.push({ f: h0, col: startSnap.col, row: startSnap.row });

    const closedSet = new Set();
    const neighbors = [
      [-1, 0, 1.0], [1, 0, 1.0], [0, -1, 1.0], [0, 1, 1.0],
      [-1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [1, 1, Math.SQRT2]
    ];

    let found = false;

    while (openSet.size() > 0) {
      const current = openSet.pop();
      const currKey = `${current.col},${current.row}`;

      if (closedSet.has(currKey)) continue;
      closedSet.add(currKey);

      if (current.col === goalCol && current.row === goalRow) {
        found = true;
        break;
      }

      const currentG = gScore.get(currKey);

      for (const [dc, dr, moveCost] of neighbors) {
        const nc = current.col + dc;
        const nr = current.row + dr;

        if (!this.isWalkable(nc, nr, navGrid)) continue;

        // Diagonal corner check
        if (dc !== 0 && dr !== 0) {
          if (!this.isWalkable(current.col, nr, navGrid) || !this.isWalkable(nc, current.row, navGrid)) {
            continue;
          }
        }

        const tentativeG = currentG + moveCost * navGrid.resolution;
        const nKey = `${nc},${nr}`;

        if (!gScore.has(nKey) || tentativeG < gScore.get(nKey)) {
          cameFrom.set(nKey, { col: current.col, row: current.row });
          gScore.set(nKey, tentativeG);
          const h = heuristic(nc, nr);
          openSet.push({ f: tentativeG + h, col: nc, row: nr });
        }
      }
    }

    if (!found) {
      return {
        found: false,
        error: 'No walkable route found between points',
        path: [],
        distanceMeters: 0,
        walkingEtaSeconds: 0,
        walkingEtaFormatted: '0s',
      };
    }

    // Reconstruct raw path
    const rawWaypoints = [{ col: goalCol, row: goalRow }];
    let currKey = `${goalCol},${goalRow}`;
    while (cameFrom.has(currKey)) {
      const prev = cameFrom.get(currKey);
      rawWaypoints.push(prev);
      currKey = `${prev.col},${prev.row}`;
    }
    rawWaypoints.reverse();

    // Smooth path
    const smoothed = this.smoothPath(rawWaypoints, navGrid);

    // Convert to world 3D coordinates
    const worldPath = [];
    worldPath.push({ x: sx, y: sy || floorY, z: sz });

    for (const pt of smoothed) {
      const w = this.gridToWorld(pt.col, pt.row, navGrid);
      worldPath.push({ x: w.x, y: floorY, z: w.z });
    }
    worldPath.push({ x: gx, y: gy || floorY, z: gz });

    // Clean close duplicates
    const cleanedPath = [worldPath[0]];
    for (let i = 1; i < worldPath.length; i++) {
      const prev = cleanedPath[cleanedPath.length - 1];
      const cur = worldPath[i];
      const d = Math.hypot(cur.x - prev.x, cur.z - prev.z);
      if (d > 0.02) {
        cleanedPath.push(cur);
      }
    }

    // Total distance
    let totalDist = 0;
    for (let i = 0; i < cleanedPath.length - 1; i++) {
      const p1 = cleanedPath[i];
      const p2 = cleanedPath[i + 1];
      totalDist += Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
    }

    const realDistMeters = totalDist * metersPerUnit;
    const etaSec = realDistMeters / Math.max(0.1, walkingSpeedMps);

    const formatEta = (sec) => {
      const s = Math.max(1, Math.round(sec));
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      const rem = s % 60;
      return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
    };

    return {
      found: true,
      path: cleanedPath,
      snappedStart: { x: startSnap.x, z: startSnap.z },
      snappedGoal: { x: goalSnap.x, z: goalSnap.z },
      rawWaypointsCount: rawWaypoints.length,
      smoothedWaypointsCount: cleanedPath.length,
      distanceMeters: Number(realDistMeters.toFixed(2)),
      walkingSpeedMps,
      walkingEtaSeconds: Number(etaSec.toFixed(1)),
      walkingEtaFormatted: formatEta(etaSec),
    };
  }
}

// Minimal binary min-heap for A* performance
class TinyMinHeap {
  constructor() {
    this.data = [];
  }
  push(item) {
    this.data.push(item);
    this._up(this.data.length - 1);
  }
  pop() {
    if (this.data.length === 0) return null;
    const top = this.data[0];
    const bottom = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = bottom;
      this._down(0);
    }
    return top;
  }
  size() {
    return this.data.length;
  }
  _up(idx) {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.data[idx].f < this.data[parent].f) {
        [this.data[idx], this.data[parent]] = [this.data[parent], this.data[idx]];
        idx = parent;
      } else {
        break;
      }
    }
  }
  _down(idx) {
    const len = this.data.length;
    while ((idx << 1) + 1 < len) {
      let left = (idx << 1) + 1;
      let right = left + 1;
      let best = idx;
      if (this.data[left].f < this.data[best].f) best = left;
      if (right < len && this.data[right].f < this.data[best].f) best = right;
      if (best !== idx) {
        [this.data[idx], this.data[best]] = [this.data[best], this.data[idx]];
        idx = best;
      } else {
        break;
      }
    }
  }
}

export const navigationService = new NavigationService();

