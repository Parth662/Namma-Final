import { POI } from '../models/POI.js';
import { Project } from '../models/Project.js';
import { navigationService } from '../services/navigation.service.js';

/**
 * Helper to check project read access (owner, public, or demo).
 */
const findProjectForRead = async (projectId, user) => {
  const query = { _id: projectId };
  if (!user) {
    query.$or = [{ isPublic: true }, { isDemo: true }];
  } else {
    query.$or = [{ userId: user._id }, { isPublic: true }, { isDemo: true }];
  }
  return Project.findOne(query);
};

/**
 * Helper to check project write access (owner or demo).
 */
const findProjectForWrite = async (projectId, user) => {
  if (!user) return null;
  return Project.findOne({
    _id: projectId,
    $or: [{ userId: user._id }, { isDemo: true }],
  });
};

/**
 * GET /api/projects/:id/pois
 * Lists POIs for a project with optional text search (?q=) and category filter (?category=).
 */
export const getPOIs = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { q, category } = req.query;

    const project = await findProjectForRead(id, req.user);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or access denied',
      });
    }

    const filter = { projectId: project._id };
    if (category) {
      filter.category = category;
    }

    let pois;

    if (q && q.trim()) {
      const searchTerm = q.trim();
      // Try MongoDB text search
      try {
        pois = await POI.find(
          { ...filter, $text: { $search: searchTerm } },
          { score: { $meta: 'textScore' } }
        )
          .sort({ score: { $meta: 'textScore' } })
          .lean();
      } catch (err) {
        pois = [];
      }

      // Regex fallback if text search returned nothing
      if (!pois || pois.length === 0) {
        const regex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        pois = await POI.find({
          ...filter,
          $or: [{ name: regex }, { tags: regex }, { description: regex }],
        })
          .sort({ createdAt: -1 })
          .lean();
      }
    } else {
      pois = await POI.find(filter).sort({ createdAt: -1 }).lean();
    }

    res.status(200).json({
      success: true,
      count: pois.length,
      data: pois,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/projects/:id/pois/:poiId
 * Retrieves a single POI by ID.
 */
export const getPOIById = async (req, res, next) => {
  try {
    const { id, poiId } = req.params;
    const project = await findProjectForRead(id, req.user);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or access denied',
      });
    }

    const poi = await POI.findOne({ _id: poiId, projectId: project._id });
    if (!poi) {
      return res.status(404).json({
        success: false,
        error: 'Point of Interest not found',
      });
    }

    res.status(200).json({
      success: true,
      data: poi,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/projects/:id/pois
 * Creates a new POI and snaps its navPoint to the nearest walkable grid cell.
 */
export const createPOI = async (req, res, next) => {
  try {
    const { id } = req.params;
    const project = await findProjectForWrite(id, req.user);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or unauthorized to add POI',
      });
    }

    const { name, category, description, tags, position, icon, color, metadata } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        error: 'POI name is required',
      });
    }

    if (!position || typeof position.x !== 'number' || typeof position.z !== 'number') {
      return res.status(400).json({
        success: false,
        error: 'Valid 3D position { x, y, z } is required',
      });
    }

    const posX = Number(position.x);
    const posY = Number(position.y || 0.0);
    const posZ = Number(position.z);

    // Snap to nearest walkable navPoint if navigation grid exists
    let navPoint = { x: posX, y: 0.0, z: posZ };
    const navGrid = await navigationService.getNavGrid(project._id);

    if (navGrid) {
      const snapped = navigationService.snapToWalkable(posX, posZ, navGrid, 3.0);
      if (!snapped) {
        return res.status(400).json({
          success: false,
          error: 'POI position is outside walkable scene boundaries',
        });
      }
      navPoint = { x: snapped.x, y: 0.0, z: snapped.z };
    }

    const poi = await POI.create({
      projectId: project._id,
      name: name.trim(),
      category: category || 'landmark',
      description: description ? description.trim() : '',
      tags: Array.isArray(tags) ? tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : [],
      position: { x: posX, y: posY, z: posZ },
      navPoint,
      createdBy: req.user._id,
      icon: icon || 'pin',
      color: color || '#3b82f6',
      metadata: metadata || {},
    });

    res.status(201).json({
      success: true,
      data: poi,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/projects/:id/pois/:poiId
 * Updates an existing POI.
 */
export const updatePOI = async (req, res, next) => {
  try {
    const { id, poiId } = req.params;
    const project = await findProjectForWrite(id, req.user);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or unauthorized to modify POI',
      });
    }

    const poi = await POI.findOne({ _id: poiId, projectId: project._id });
    if (!poi) {
      return res.status(404).json({
        success: false,
        error: 'Point of Interest not found',
      });
    }

    const { name, category, description, tags, position, icon, color, metadata } = req.body;

    if (name !== undefined) poi.name = name.trim();
    if (category !== undefined) poi.category = category;
    if (description !== undefined) poi.description = description.trim();
    if (Array.isArray(tags)) poi.tags = tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    if (icon !== undefined) poi.icon = icon;
    if (color !== undefined) poi.color = color;
    if (metadata !== undefined) poi.metadata = metadata;

    if (position && typeof position.x === 'number' && typeof position.z === 'number') {
      const posX = Number(position.x);
      const posY = Number(position.y || 0.0);
      const posZ = Number(position.z);
      poi.position = { x: posX, y: posY, z: posZ };

      const navGrid = await navigationService.getNavGrid(project._id);
      if (navGrid) {
        const snapped = navigationService.snapToWalkable(posX, posZ, navGrid, 3.0);
        if (snapped) {
          poi.navPoint = { x: snapped.x, y: 0.0, z: snapped.z };
        }
      }
    }

    await poi.save();

    res.status(200).json({
      success: true,
      data: poi,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/projects/:id/pois/:poiId
 * Deletes a POI.
 */
export const deletePOI = async (req, res, next) => {
  try {
    const { id, poiId } = req.params;
    const project = await findProjectForWrite(id, req.user);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or unauthorized to delete POI',
      });
    }

    const poi = await POI.findOneAndDelete({ _id: poiId, projectId: project._id });
    if (!poi) {
      return res.status(404).json({
        success: false,
        error: 'Point of Interest not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Point of Interest deleted successfully',
      poiId: poi._id,
    });
  } catch (error) {
    next(error);
  }
};

