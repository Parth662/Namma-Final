import mongoose from 'mongoose';

const positionSchema = new mongoose.Schema(
  {
    x: { type: Number, required: true },
    y: { type: Number, required: true, default: 0.0 },
    z: { type: Number, required: true },
  },
  { _id: false }
);

const poiSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'POI name is required'],
      trim: true,
      maxlength: [120, 'POI name cannot exceed 120 characters'],
    },
    category: {
      type: String,
      enum: ['room', 'equipment', 'emergency', 'entrance', 'restroom', 'amenity', 'landmark', 'other'],
      default: 'landmark',
      index: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    tags: {
      type: [String],
      default: [],
      index: true,
    },
    position: {
      type: positionSchema,
      required: true,
    },
    navPoint: {
      type: positionSchema,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    icon: {
      type: String,
      default: 'pin',
    },
    color: {
      type: String,
      default: '#3b82f6',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Compound text index for ranked multi-field search
poiSchema.index(
  {
    name: 'text',
    tags: 'text',
    description: 'text',
  },
  {
    weights: {
      name: 10,
      tags: 5,
      description: 2,
    },
    name: 'PoiTextSearchIndex',
  }
);

poiSchema.index({ projectId: 1, category: 1 });

export const POI = mongoose.model('POI', poiSchema);

