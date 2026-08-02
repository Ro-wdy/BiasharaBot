## Bug: Weekly report doesn't scope by date — accumulates all-time instead

**Where:** `GET /api/reports/weekly` in server.js

**What's happening:**
The report endpoint fetches all entries for a business with no date range:
```js
const entries = await Entry.find({ business_id: bid });
```
This means every "weekly" report actually includes every transaction ever logged, growing larger over time instead of resetting per day/week.

**Expected behavior:**
The query should filter entries to the current week (e.g. `timestamp: { $gte: startOfWeek, $lte: endOfWeek }`), so each week's report reflects only that week's transactions.

**Suggested fix:**
Add a date range filter using something like `date-fns` or plain JS Date math to compute the start of the current week, and include it in the Mongoose query.

**Found while:** manually walking through a real week of transaction data per the Claude Community Kenya pilot feedback.