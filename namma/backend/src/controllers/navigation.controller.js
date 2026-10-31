import { Project } from '../models/Project.js';
import { navigationService } from '../services/navigation.service.js';

/**
 * Helper to check project read access (owner, public, or demo).
 */
const findAuthorizedProject = async (id, user) => {
  const query = { _id: id };
  if (!user) {
    query.$or = [{ isPublic: true }, { isDemo: true }];
  } else {
    query.$or = [{ userId: user._id }, { isPublic: true }, { isDemo: true }];
  }
  return Project.findOne(query);
};

/**
 * GET /api/projects/:id/navgrid
 * Retrieves the 2D occupancy grid and wall segments for a project.
 */
export const getProjectNavGrid = async (req, res, next) => {
  try {
    const { id } = req.params;
    const project = await findAuthorizedProject(id, req.user);

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or access denied',
      });
    }

    const navGrid = await navigationService.getNavGrid(project._id);

    if (!navGrid) {
      return res.status(404).json({
        success: false,
        error: 'Navigation grid has not been generated for this project yet',
      });
    }

    res.status(200).json({
      success: true,
      projectId: project._id,
      metersPerUnit: project.metersPerUnit || 1.0,
      data: navGrid,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/projects/:id/path?from=x,y,z&to=x,y,z
 * Calculates an obstacle-avoiding walking route between two 3D coordinates.
 */
export const getProjectPath = async (req, res, next) => {
  try {
    const { id } = req.params;
    const project = await findAuthorizedProject(id, req.user);

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or access denied',
      });
    }

    const { from, to, startX, startY, startZ, goalX, goalY, goalZ, walkingSpeed } = req.query;

    let pFrom = null;
    let pTo = null;

    if (from) {
      const parts = from.split(',').map(Number);
      if (parts.length >= 2) {
        pFrom = [parts[0], parts[1] || 0.0, parts[2] !== undefined ? parts[2] : (parts.length === 2 ? parts[1] : 0.0)];
      }
    } else if (startX !== undefined && startZ !== undefined) {
      pFrom = [Number(startX), Number(startY || 0.0), Number(startZ)];
    }

    if (to) {
      const parts = to.split(',').map(Number);
      if (parts.length >= 2) {
        pTo = [parts[0], parts[1] || 0.0, parts[2] !== undefined ? parts[2] : (parts.length === 2 ? parts[1] : 0.0)];
      }
    } else if (goalX !== undefined && goalZ !== undefined) {
      pTo = [Number(goalX), Number(goalY || 0.0), Number(goalZ)];
    }

    if (!pFrom || !pTo || pFrom.some(isNaN) || pTo.some(isNaN)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid coordinates. Provide ?from=x,y,z&to=x,y,z or ?startX=...&startZ=...&goalX=...&goalZ=...',
      });
    }

    const navGrid = await navigationService.getNavGrid(project._id);
    if (!navGrid) {
      return res.status(404).json({
        success: false,
        error: 'Navigation grid has not been generated for this project yet',
      });
    }

    const result = navigationService.findPath(navGrid, pFrom, pTo, {
      metersPerUnit: project.metersPerUnit || 1.0,
      walkingSpeedMps: walkingSpeed ? Number(walkingSpeed) : 1.3,
    });

    res.status(200).json({
      success: result.found,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
