import express from 'express';
import cors from 'cors';
import multer from 'multer';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Entry from './models/Entry.js';
import Business from './models/Business.js';
import { parseTextWithGemini, parseAudioWithGemini } from './gemini.js';
import { triggerSTKPush } from './payments.js';
import { sendSMS } from './sms.js';
import bcrypt from 'bcryptjs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// Memory storage for audio uploads (prevents disk clutter)
const upload = multer({ storage: multer.memoryStorage() });

// MongoDB Connection
const mongoURI = process.env.MONGODB_URI;
if (!mongoURI) {
  console.error("CRITICAL ERROR: MONGODB_URI environment variable is not defined in .env file.");
} else {
  mongoose.connect(mongoURI)
    .then(() => console.log("Connected successfully to MongoDB Atlas."))
    .catch(err => {
      console.error("MongoDB connection error:", err);
      console.log("Ensure your IP address is whitelisted in MongoDB Atlas and the credentials in MONGODB_URI are correct.");
    });
}

// 1. Text Entry Endpoint
app.post('/api/entries/text', async (req, res) => {
  try {
    const { text, businessId } = req.body;
    if (!text) {
      return res.status(400).json({ error: "Text entry is required" });
    }

    const parsed = await parseTextWithGemini(text);
    console.log("[TEXT PARSED SUCCESS]", parsed);

    const entry = new Entry({
      business_id: businessId || 'demo-shop',
      type: parsed.type,
      item: parsed.item,
      qty: parsed.qty,
      unit_price: parsed.unit_price,
      total: parsed.total,
      transcription: parsed.transcription || text,
      source: 'text',
      matched: false
    });

    await entry.save();
    res.status(201).json(entry);
  } catch (error) {
    console.error("Text entry endpoint error:", error);
    res.status(500).json({ error: "Failed to process text entry", details: error.message });
  }
});

// 2. Voice Entry Endpoint
app.post('/api/entries/voice', upload.single('audio'), async (req, res) => {
  try {
    const { businessId } = req.body;
    if (!req.file) {
      return res.status(400).json({ error: "Audio file is required" });
    }

    // Pass the buffer and mimetype directly to Gemini
    const mimeType = req.file.mimetype || 'audio/webm';
    console.log(`[VOICE UPLOADED] File size: ${req.file.size} bytes, Mime: ${mimeType}`);

    const parsed = await parseAudioWithGemini(req.file.buffer, mimeType);
    console.log("[AUDIO PARSED SUCCESS]", parsed);

    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    const entry = new Entry({
      business_id: businessId || 'demo-shop',
      type: parsed.type,
      item: parsed.item,
      qty: parsed.qty,
      unit_price: parsed.unit_price,
      total: parsed.total,
      transcription: parsed.transcription || 'Spoken transaction',
      source: 'voice',
      matched: false
    });

    await entry.save();
    res.status(201).json(entry);
  } catch (error) {
    console.error("Voice entry endpoint error:", error);
    res.status(500).json({ error: "Failed to process voice entry", details: error.message });
  }
});

// 3. Retrieve Entries Endpoint
app.get('/api/entries', async (req, res) => {
  try {
    const { businessId } = req.query;
    const bid = businessId || 'demo-shop';
    const entries = await Entry.find({ business_id: bid }).sort({ timestamp: -1 });
    res.json(entries);
  } catch (error) {
    console.error("Get entries error:", error);
    res.status(500).json({ error: "Failed to fetch entries" });
  }
});

// 4. Trigger STK Push Endpoint
app.post('/api/payments/stk-push', async (req, res) => {
  try {
    const { entryId, phone } = req.body;
    if (!entryId || !phone) {
      return res.status(400).json({ error: "Entry ID and Phone number are required" });
    }

    const entry = await Entry.findById(entryId);
    if (!entry) {
      return res.status(404).json({ error: "Ledger entry not found" });
    }

    // Get the business to extract its PayHero Till Number/Channel ID
    const biz = await Business.findOne({ id: entry.business_id });
    const channelId = biz ? biz.tillNumber : null;

    // Formulate a callback URL (usually public-facing host + route)
    // For local testing, the simulator is used; for live payments, we pass the server's endpoint
    const host = req.get('host');
    const protocol = req.secure ? 'https' : 'http';
    const callbackUrl = `${protocol}://${host}/api/webhooks/payhero`;

    const result = await triggerSTKPush({
      amount: entry.total,
      phone,
      entryId: entry._id.toString(),
      callbackUrl,
      channelId
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    console.error("STK push endpoint error:", error);
    res.status(500).json({ error: "Failed to trigger payment" });
  }
});

// 5. PayHero M-Pesa Webhook Endpoint (Reconciliation)
app.post('/api/webhooks/payhero', async (req, res) => {
  try {
    console.log("[PAYHERO WEBHOOK RECEIVED] Payload:", req.body);

    const payload = req.body;
    // Extract properties, handling common alternative naming conventions
    const status = payload.status || (payload.ResultCode === 0 ? 'success' : 'failed');
    const amount = parseFloat(payload.amount || payload.Amount || 0);
    const externalRef = payload.external_reference || payload.merchant_transaction_id || payload.CheckoutRequestID;
    const serviceCharge = parseFloat(payload.service_charge || payload.ServiceCharge || 0);
    const phone = payload.phone || payload.phone_number || (payload.MpesaReceiptNumber ? 'M-Pesa Customer' : '');

    if (status !== 'success' && status !== 'SUCCESS') {
      console.log(`[PAYHERO WEBHOOK] Transaction failed or status is not success: ${status}`);
      return res.json({ status: "acknowledged", message: "Non-success status ignored" });
    }

    let matchedEntry = null;

    // 1. Try to match using external reference ID if it is a valid ObjectId
    if (externalRef && mongoose.Types.ObjectId.isValid(externalRef)) {
      matchedEntry = await Entry.findById(externalRef);
      if (matchedEntry) {
        console.log(`[RECONCILIATION] Matched by ID: ${externalRef}`);
        matchedEntry.matched = true;
        await matchedEntry.save();
      }
    }

    // 2. If no match by ID, search by amount (oldest unmatched sale)
    if (!matchedEntry && amount > 0) {
      matchedEntry = await Entry.findOne({
        type: 'sale',
        total: amount,
        matched: false,
        source: { $in: ['voice', 'text'] }
      }).sort({ timestamp: 1 });

      if (matchedEntry) {
        console.log(`[RECONCILIATION] Matched by amount (KSh ${amount}) to Entry: ${matchedEntry._id}`);
        matchedEntry.matched = true;
        await matchedEntry.save();
      } else {
        // 3. No match found, record a new spontaneous sale entry
        console.log(`[RECONCILIATION] Unmatched payment of KSh ${amount}. Creating new entry.`);
        matchedEntry = new Entry({
          business_id: 'demo-shop',
          type: 'sale',
          item: `M-Pesa Payment (${phone || 'Unrecognized'})`,
          qty: 1,
          unit_price: amount,
          total: amount,
          source: 'payhero',
          matched: false
        });
        await matchedEntry.save();
      }
    }

    // Record the M-Pesa Transaction Fee/Service Charge as an expense
    if (serviceCharge > 0) {
      console.log(`[RECONCILIATION] Recording M-Pesa service charge: KSh ${serviceCharge}`);
      const feeEntry = new Entry({
        business_id: matchedEntry ? matchedEntry.business_id : 'demo-shop',
        type: 'expense',
        item: `M-Pesa Fee (PH_${externalRef || 'webhook'})`,
        qty: 1,
        unit_price: serviceCharge,
        total: serviceCharge,
        source: 'payhero',
        matched: true
      });
      await feeEntry.save();
    }

    res.json({ status: "success", message: "Transaction reconciled successfully" });
  } catch (error) {
    console.error("Webhook endpoint error:", error);
    res.status(500).json({ error: "Webhook processing failed", details: error.message });
  }
});

// 6. Weekly Report Endpoint & SMS Trigger
function buildReportMessage({ title, businessName, revenue, cost_of_goods, other_expenses, mpesa_fees, net_profit, outstanding_credit }) {
  return `${title}\n` +
    `Shop: ${businessName}\n` +
    `---------------------\n` +
    `Revenue: KSh ${revenue.toFixed(2)}\n` +
    `Cost of Goods: KSh ${cost_of_goods.toFixed(2)}\n` +
    `Other Expenses: KSh ${other_expenses.toFixed(2)}\n` +
    `M-Pesa Fees: KSh ${mpesa_fees.toFixed(2)}\n` +
    `---------------------\n` +
    `Net Profit: KSh ${net_profit.toFixed(2)}\n` +
    `Outstanding Credit: KSh ${outstanding_credit.toFixed(2)}\n` +
    `---------------------\n` +
    `Powered by BiasharaGPT!`;
}

app.get('/api/reports/weekly', async (req, res) => {
  try {
    const { businessId, phone, businessName } = req.query;
    const bid = businessId || 'demo-shop';
    const bname = businessName || 'My Duka';

    console.log(`[WEEKLY REPORT] Generating report for Business: ${bname} (${bid})`);

    // Fetch all entries for this business
    const entries = await Entry.find({ business_id: bid });

    // Compute Metrics
    const revenue = entries
      .filter(e => e.type === 'sale')
      .reduce((sum, e) => sum + e.total, 0);

    const cost_of_goods = entries
      .filter(e => e.type === 'purchase')
      .reduce((sum, e) => sum + e.total, 0);

    const other_expenses = entries
      .filter(e => e.type === 'expense' && e.source !== 'payhero')
      .reduce((sum, e) => sum + e.total, 0);

    const mpesa_fees = entries
      .filter(e => e.type === 'expense' && e.source === 'payhero')
      .reduce((sum, e) => sum + e.total, 0);

    const outstanding_credit = entries
      .filter(e => e.type === 'credit' && !e.matched)
      .reduce((sum, e) => sum + e.total, 0);

    const net_profit = revenue - cost_of_goods - other_expenses - mpesa_fees;

    const report = {
      revenue,
      cost_of_goods,
      other_expenses,
      mpesa_fees,
      net_profit,
      outstanding_credit
    };

    // Trigger Outbound SMS if phone number is provided
    let smsStatus = null;
    if (phone) {
      const smsMessage = buildReportMessage({
        title: 'BiasharaGPT Weekly Report',
        businessName: bname,
        revenue,
        cost_of_goods,
        other_expenses,
        mpesa_fees,
        net_profit,
        outstanding_credit
      });

      smsStatus = await sendSMS({ to: phone, message: smsMessage });
    }

    res.json({
      success: true,
      report,
      smsStatus
    });
  } catch (error) {
    console.error("Weekly report endpoint error:", error);
    res.status(500).json({ error: "Failed to generate weekly report", details: error.message });
  }
});

  // 6b. Schedule a Mock Daily Report SMS for 60 seconds later
  app.post('/api/reports/daily/schedule-test', async (req, res) => {
    try {
      const { phone = '0743177132', businessName = 'My Duka' } = req.body || {};

      const mockReport = {
        revenue: 12500,
        cost_of_goods: 7300,
        other_expenses: 1200,
        mpesa_fees: 50,
        net_profit: 3950,
        outstanding_credit: 800
      };

      const message = buildReportMessage({
        title: 'BiasharaGPT Daily Report',
        businessName,
        ...mockReport
      });

      const jobId = `daily_report_${Date.now()}`;
      const delayMs = 60_000;

      setTimeout(async () => {
        try {
          console.log(`[SCHEDULED SMS] Sending job ${jobId} to ${phone}`);
          const result = await sendSMS({ to: phone, message });
          console.log(`[SCHEDULED SMS] Job ${jobId} completed:`, result);
        } catch (error) {
          console.error(`[SCHEDULED SMS] Job ${jobId} failed:`, error);
        }
      }, delayMs);

      res.json({
        success: true,
        scheduled: true,
        jobId,
        sendInSeconds: 60,
        phone,
        messagePreview: message
      });
    } catch (error) {
      console.error('Daily schedule test endpoint error:', error);
      res.status(500).json({ error: 'Failed to schedule daily report SMS', details: error.message });
    }
  });

// 7. Verify Admin Password Endpoint
app.post('/api/admin/verify', async (req, res) => {
  try {
    const { password, businessId } = req.body;
    if (!businessId) {
      return res.status(400).json({ error: "Business ID is required for verification" });
    }
    
    const biz = await Business.findOne({ id: businessId });
    if (!biz) {
      return res.status(404).json({ error: "Business profile not found" });
    }
    
    const match = await bcrypt.compare(password, biz.password);
    if (match) {
      return res.json({ success: true });
    } else {
      return res.status(401).json({ error: "Invalid admin password" });
    }
  } catch (error) {
    console.error("Admin verification error:", error);
    res.status(500).json({ error: "Server error during verification" });
  }
});

// 8. Sign Up Business Endpoint
app.post('/api/business', async (req, res) => {
  try {
    const { name, phone, email, password, confirmPassword, tillNumber } = req.body;
    if (!name || !phone || !email || !password || !confirmPassword) {
      return res.status(400).json({ error: "All fields are required" });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    let id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const existing = await Business.findOne({ id });
    if (existing) {
      id = `${id}-${Math.floor(1000 + Math.random() * 9000)}`;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const business = new Business({
      id,
      name,
      phone,
      email,
      password: hashedPassword,
      tillNumber: tillNumber || process.env.PAYHERO_CHANNEL_ID || '6669'
    });

    await business.save();
    console.log(`[BUSINESS REGISTERED] ID: ${id}, Name: ${name}, Email: ${email}`);
    
    const responseBiz = {
      id: business.id,
      name: business.name,
      phone: business.phone,
      email: business.email,
      tillNumber: business.tillNumber
    };
    
    res.status(201).json(responseBiz);
  } catch (error) {
    console.error("Business signup error:", error);
    res.status(500).json({ error: "Failed to register business profile" });
  }
});

// 9. Fetch Business Details Endpoint
app.get('/api/business/:id', async (req, res) => {
  try {
    const business = await Business.findOne({ id: req.params.id }).select('-password');
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }
    res.json(business);
  } catch (error) {
    console.error("Fetch business details error:", error);
    res.status(500).json({ error: "Failed to retrieve business profile" });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`BiasharaGPT Server running on http://localhost:${PORT}`);
});
// Nodemon trigger change


