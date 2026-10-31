import mongoose from 'mongoose';

const boundingBoxSchema = new mongoose.Schema(
  {
    minX: { type: Number, default: 0 },
    minY: { type: Number, default: 0 },
    minZ: { type: Number, default: 0 },
    maxX: { type: Number, default: 0 },
    maxY: { type: Number, default: 0 },
    maxZ: { type: Number, default: 0 },
  },
  { _id: false }
);

const projectSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Project name is required'],
      trim: true,
      maxlength: [120, 'Project name cannot exceed 120 characters'],
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    locationName: {
      type: String,
      trim: true,
      default: '',
    },
    latitude: {
      type: Number,
      default: null,
    },
    longitude: {
      type: Number,
      default: null,
    },
    videoUrl: {
      type: String,
      default: null,
    },
    thumbnailUrl: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ['created', 'uploaded', 'queued', 'processing', 'completed', 'failed', 'rejected', 'cancelled'],
      default: 'created',
      index: true,
    },
    progress: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    currentStage: {
      type: String,
      default: 'CREATED',
    },
    rejectionReason: {
      type: String,
      default: null,
    },
    rejectionSuggestion: {
      type: String,
      default: null,
    },
    videoDurationSeconds: {
      type: Number,
      default: null,
    },
    videoResolution: {
      type: String,
      default: null,
    },
    videoCodec: {
      type: String,
      default: null,
    },
    outputType: {
      type: String,
      default: 'glb',
    },
    modelUrl: {
      type: String,
      default: null,
    },
    previewUrl: {
      type: String,
      default: null,
    },
    boundingBox: {
      type: boundingBoxSchema,
      default: () => ({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }),
    },
    reconstructionMetadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

export const Project = mongoose.model('Project', projectSchema);
