import mongoose from 'mongoose';

const entrySchema = new mongoose.Schema({
  business_id: { type: String, required: true, default: 'demo-shop' },
  type: { type: String, enum: ['sale', 'purchase', 'expense', 'credit'], required: true },
  item: { type: String, required: true },
  qty: { type: Number, required: true },
  unit_price: { type: Number, required: true },
  total: { type: Number, required: true },
  source: { type: String, enum: ['voice', 'text', 'payhero'], required: true },
  transcription: { type: String },
  matched: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now }
});

const Entry = mongoose.model('Entry', entrySchema);
export default Entry;
