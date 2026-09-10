import mongoose from 'mongoose';

const tetrisScoreSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    score: { type: Number, required: true, index: -1 },
    level: { type: Number, default: 1 },
    lines: { type: Number, default: 0 },
    duration: { type: Number, default: 0 }, // segundos jugados
  },
  { timestamps: true }
);

// Best score per user (compound)
tetrisScoreSchema.index({ user: 1, score: -1 });

export default mongoose.model('TetrisScore', tetrisScoreSchema);
