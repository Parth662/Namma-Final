import mongoose from 'mongoose';

const reconstructionJobSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['created', 'queued', 'processing', 'completed', 'failed', 'rejected', 'cancelled'],
      default: 'queued',
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
      default: 'QUEUED',
    },
    rejectionReason: {
      type: String,
      default: null,
    },
    rejectionSuggestion: {
      type: String,
      default: null,
    },
    videoPath: {
      type: String,
      default: null,
    },
    frameCount: {
      type: Number,
      default: 0,
    },
    reconstructionPath: {
      type: String,
      default: null,
    },
    pointCloudPath: {
      type: String,
      default: null,
    },
    meshPath: {
      type: String,
      default: null,
    },
    texturePath: {
      type: String,
      default: null,
    },
    finalModelPath: {
      type: String,
      default: null,
    },
    error: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

export const ReconstructionJob = mongoose.model('ReconstructionJob', reconstructionJobSchema);
