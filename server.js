const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── IN-MEMORY STORAGE ──
// SMS গুলো এখানে জমা হবে
let smsInbox = [];
// Orders গুলো এখানে থাকবে
let orders = [];

// ══════════════════════════════════════════
// SMS PARSING — bKash / Nagad / Rocket
// ══════════════════════════════════════════
function parseSMS(smsText, sender) {
  const text = smsText.toLowerCase();
  let result = { valid: false, txnID: null, amount: null, method: null, raw: smsText };

  // ── bKash SMS Parse ──
  // "You have received Tk 229.00 from 01XXXXXXXXX. TrxID- ABC12345DE"
  if (text.includes('bkash') || text.includes('trxid') || text.includes('you have received tk')) {
    const amountMatch = smsText.match(/(?:received\s+Tk|Tk)\s*([\d,]+(?:\.\d+)?)/i);
    const txnMatch = smsText.match(/TrxID[- :]+([A-Z0-9]+)/i);
    if (amountMatch && txnMatch) {
      result.valid = true;
      result.method = 'bKash';
      result.amount = parseFloat(amountMatch[1].replace(',', ''));
      result.txnID = txnMatch[1].trim().toUpperCase();
    }
  }

  // ── Nagad SMS Parse ──
  // "Cash In! Amount: 229.00 Tk TxnID: XXXXXXXXXXX"
  else if (text.includes('nagad') || text.includes('cash in') || (text.includes('amount:') && text.includes('txnid'))) {
    const amountMatch = smsText.match(/Amount[: ]+([\d,]+(?:\.\d+)?)/i);
    const txnMatch = smsText.match(/TxnID[: ]+([A-Z0-9]+)/i);
    if (amountMatch && txnMatch) {
      result.valid = true;
      result.method = 'Nagad';
      result.amount = parseFloat(amountMatch[1].replace(',', ''));
      result.txnID = txnMatch[1].trim().toUpperCase();
    }
  }

  // ── Rocket/DBBL SMS Parse ──
  // "TxnID: XXXXXXXXXXX Amount: 229 BDT"
  else if (text.includes('rocket') || text.includes('dbbl') || text.includes('dutch')) {
    const amountMatch = smsText.match(/Amount[: ]+([\d,]+(?:\.\d+)?)/i);
    const txnMatch = smsText.match(/(?:TxnID|TransactionID)[: ]+([A-Z0-9]+)/i);
    if (amountMatch && txnMatch) {
      result.valid = true;
      result.method = 'Rocket';
      result.amount = parseFloat(amountMatch[1].replace(',', ''));
      result.txnID = txnMatch[1].trim().toUpperCase();
    }
  }

  return result;
}

// ══════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════

// ✅ Health check
app.get('/', (req, res) => {
  res.json({
    status: 'GPX-FF Server চালু আছে ✅',
    smsCount: smsInbox.length,
    orderCount: orders.length,
    time: new Date().toLocaleString('bn-BD')
  });
});

// ══════════════════════════════════════════
// 📱 SMS RECEIVE — Android app এখানে SMS পাঠাবে
// POST /api/sms-receive
// Body: { message: "SMS text", sender: "01XXXXXXXXX", timestamp: "..." }
// ══════════════════════════════════════════
app.post('/api/sms-receive', (req, res) => {
  const { message, sender, timestamp } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });

  const parsed = parseSMS(message, sender);
  const smsEntry = {
    id: Date.now(),
    raw: message,
    sender: sender || 'Unknown',
    timestamp: timestamp || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    ...parsed
  };

  smsInbox.unshift(smsEntry);
  // শুধু শেষ 500টি SMS রাখব
  if (smsInbox.length > 500) smsInbox = smsInbox.slice(0, 500);

  console.log(`📱 SMS এসেছে: ${parsed.method || 'Unknown'} | TxnID: ${parsed.txnID} | Amount: ${parsed.amount}`);

  res.json({
    success: true,
    parsed: {
      method: parsed.method,
      txnID: parsed.txnID,
      amount: parsed.amount,
      valid: parsed.valid
    }
  });
});

// ══════════════════════════════════════════
// 🔍 TRANSACTION VERIFY — Customer TxnID দিলে check করবে
// POST /api/verify-txn
// Body: { txnID: "ABC123", amount: 229, method: "bKash" }
// ══════════════════════════════════════════
app.post('/api/verify-txn', (req, res) => {
  const { txnID, amount, method } = req.body;
  if (!txnID) return res.status(400).json({ success: false, message: 'TxnID দিন' });

  const cleanTxnID = txnID.trim().toUpperCase();
  const expectedAmount = parseFloat(amount);

  // SMS inbox-এ TxnID খুঁজব
  const found = smsInbox.find(sms =>
    sms.txnID && sms.txnID.toUpperCase() === cleanTxnID
  );

  if (!found) {
    return res.json({
      success: false,
      status: 'not_found',
      message: '❌ এই TxnID দিয়ে কোনো payment পাওয়া যায়নি। সঠিক TxnID দিন।'
    });
  }

  // Amount check
  if (expectedAmount && Math.abs(found.amount - expectedAmount) > 1) {
    return res.json({
      success: false,
      status: 'amount_mismatch',
      message: `❌ Amount মিলছে না! পাওয়া গেছে ৳${found.amount} কিন্তু দরকার ৳${expectedAmount}`
    });
  }

  // Already used check
  if (found.used) {
    return res.json({
      success: false,
      status: 'already_used',
      message: '❌ এই TxnID আগেই ব্যবহার করা হয়েছে!'
    });
  }

  // ✅ সফল! TxnID mark করব যাতে duplicate না হয়
  found.used = true;
  found.usedAt = new Date().toISOString();

  return res.json({
    success: true,
    status: 'verified',
    message: `✅ Payment verify সফল! ৳${found.amount} পাওয়া গেছে।`,
    data: {
      txnID: found.txnID,
      amount: found.amount,
      method: found.method,
      receivedAt: found.receivedAt
    }
  });
});

// ══════════════════════════════════════════
// 📦 ORDER MANAGEMENT
// ══════════════════════════════════════════

// নতুন অর্ডার সেভ করব
app.post('/api/orders', (req, res) => {
  const order = {
    id: 'GPX-' + Math.random().toString(36).substring(2, 7).toUpperCase(),
    ...req.body,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  orders.unshift(order);
  if (orders.length > 1000) orders = orders.slice(0, 1000);
  res.json({ success: true, orderId: order.id, order });
});

// সব অর্ডার দেখব (Admin)
app.get('/api/orders', (req, res) => {
  const { status } = req.query;
  const result = status ? orders.filter(o => o.status === status) : orders;
  res.json({ success: true, orders: result, total: result.length });
});

// অর্ডার complete করব (Admin)
app.post('/api/orders/:id/complete', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order পাওয়া যায়নি' });
  order.status = 'done';
  order.completedAt = new Date().toISOString();
  res.json({ success: true, order });
});

// অর্ডার reject করব (Admin)
app.post('/api/orders/:id/reject', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order পাওয়া যায়নি' });
  order.status = 'rejected';
  order.rejectedAt = new Date().toISOString();
  res.json({ success: true, order });
});

// ══════════════════════════════════════════
// 📋 SMS INBOX দেখব (Admin)
// ══════════════════════════════════════════
app.get('/api/sms-inbox', (req, res) => {
  res.json({
    success: true,
    total: smsInbox.length,
    sms: smsInbox.slice(0, 100)
  });
});

// SMS inbox clear করব
app.delete('/api/sms-inbox', (req, res) => {
  smsInbox = [];
  res.json({ success: true, message: 'SMS inbox clear হয়েছে' });
});

// Server চালু করব
app.listen(PORT, () => {
  console.log(`🚀 GPX-FF Server চালু: http://localhost:${PORT}`);
  console.log(`📱 SMS Receive URL: http://localhost:${PORT}/api/sms-receive`);
  console.log(`🔍 Verify URL: http://localhost:${PORT}/api/verify-txn`);
});
