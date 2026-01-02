require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
mongoose.connect(process.env.MONGO_URI);
const { User, Invoice, Settings } = require('./models');
const slotsRouter = require('./routes/slots');
const adminRouter = require('./routes/admin');
const fair = require('./utils/fair');
const axios = require('axios');

const CRYPTO_TOKEN = process.env.CRYPTO_TOKEN;
const SERVER_URL = process.env.SERVER_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
const BOT_TOKEN = process.env.BOT_TOKEN;

app.use('/', slotsRouter);
app.use('/admin', adminRouter);

// Тест
app.post('/test', (req, res) => {
  console.log('[SERVER] Test:', req.body);
  res.json({received: true});
});

// Регистрация
app.post('/user/register', async (req, res) => {
  const {uid, refCode} = req.body;
  const user = await User.findOneAndUpdate({uid}, {}, {upsert: true, new: true});
  
  if (refCode && !user.ref && refCode !== uid) {
    const refUser = await User.findOne({uid: refCode});
    if (refUser) {
      user.ref = refCode;
      if (refUser.ref) user.ref2 = refUser.ref;
      await user.save();
    }
  }
  res.sendStatus(200);
});

// Создать invoice для депозита
app.post('/deposit', async (req, res) => {
  const {uid, amount, refCode} = req.body;
  
  try {
    const {data} = await axios.post('https://pay.crypt.bot/api/createInvoice', {
      asset: 'USDT', amount: String(amount), description: `Deposit ${amount} USDT`
    }, {headers: {'Crypto-Pay-API-Token': CRYPTO_TOKEN}});
    
    await Invoice.create({
      iid: data.result.invoice_id,
      uid,
      amount,
      type: 'deposit',
      refCode
    });
    
    res.json({invoiceUrl: data.result.pay_url, invoiceId: data.result.invoice_id});
  } catch (e) {
    console.error('[SERVER] Deposit error:', e.response?.data || e.message);
    res.status(500).json({error: 'Failed to create invoice'});
  }
});

// ☑️ РУЧНАЯ ПРОВЕРКА ДЕПОЗИТА
app.post('/check-deposit', async (req, res) => {
  const {invoiceId} = req.body;
  if (!invoiceId) return res.status(400).json({error: 'No invoice ID'});
  
  const inv = await Invoice.findOne({iid: invoiceId});
  if (!inv) return res.status(404).json({error: 'Invoice not found'});
  if (inv.status === 'paid') return res.json({status: 'paid', amount: inv.amount, alreadyProcessed: true});
  
  try {
    const {data} = await axios.get('https://pay.crypt.bot/api/getInvoices', {
      params: {invoice_ids: invoiceId},
      headers: {'Crypto-Pay-API-Token': CRYPTO_TOKEN}
    });
    
    const invoice = data.result.items[0];
    if (!invoice) return res.json({status: 'not_found'});
    
    if (invoice.status === 'paid') {
      const user = await User.findOneAndUpdate(
        {uid: inv.uid},
        {$inc: {balance: inv.amount, totalDeposited: inv.amount}},
        {upsert: true, new: true}
      );
      
      // Реферальные (5% + 2%)
      if (inv.refCode && inv.refCode !== inv.uid) {
        const ref1 = await User.findOne({uid: inv.refCode});
        if (ref1) {
          const ref1Bonus = inv.amount * 0.05;
          ref1.refEarn += ref1Bonus;
          ref1.balance += ref1Bonus;
          await ref1.save();
          
          if (ref1.ref) {
            const ref2 = await User.findOne({uid: ref1.ref});
            if (ref2) {
              const ref2Bonus = inv.amount * 0.02;
                ref2.refEarn += ref2Bonus;
              ref2.balance += ref2Bonus;
              await ref2.save();
            }
          }
        }
      }
      
      inv.status = 'paid';
      await inv.save();
      
      res.json({status: 'paid', amount: inv.amount, newBalance: user.balance});
    } else {
      res.json({status: invoice.status});
    }
  } catch (e) {
    console.error('[SERVER] Check deposit error:', e.response?.data || e.message);
    res.status(500).json({error: 'Failed to check invoice'});
  }
});

// ☑️ ВЫВОД ЧЕКОМ (мин. 0.2 USDT)
app.post('/withdraw', async (req, res) => {
  const {uid, amount} = req.body;
  
  if (amount < 0.2) {
    return res.status(400).json({error: 'Minimum withdrawal is 0.20 USDT'});
  }
  
  const user = await User.findOne({uid});
  if (!user || user.balance < amount) {
    return res.status(400).json({error: 'Insufficient balance'});
  }
  
  try {
    const spend_id = 'check' + uid + Date.now();
    const {data} = await axios.post('https://pay.crypt.bot/api/createCheck', {
      asset: 'USDT', amount: String(amount.toFixed(2)), spend_id
    }, {headers: {'Crypto-Pay-API-Token': CRYPTO_TOKEN}});
    
    user.balance -= amount;
    await user.save();
    
    // ✅ ПРАВИЛЬНАЯ ССЫЛКА: t.me/send?start=CHECK_ID
    const checkLink = `https://t.me/send?start=${data.result.check_id}`;
    
    res.json({
      success: true,
      newBalance: user.balance.toFixed(2),
      checkId: data.result.check_id,
      checkLink
    });
  } catch (e) {
    console.error('[SERVER] Create check error:', e.response?.data || e.message);
    res.status(500).json({error: e.response?.data?.error?.name || 'Failed'});
  }
});

// Игра монетка
app.post('/play/coin', async (req, res) => {
  const {uid, betAmount, side, clientSeed} = req.body;
  const user = await User.findOne({uid});
  
  if (!user || user.balance < betAmount) {
    return res.status(400).json({error: 'Insufficient balance'});
  }
  
  const {serverSeed, hash} = fair.generateRound();
  const settings = await Settings.findOne();
  const {win} = fair.calculateWin(serverSeed, clientSeed, settings?.houseEdge || 0.05);
  
  user.balance -= betAmount;
  const prize = win ? betAmount * (1.9 - (settings?.houseEdge || 0.05)) : 0;
  user.balance += prize;
  await user.save();
  
  // Реферальные 1% от ставки
  if (user.ref) {
    const ref1 = await User.findOne({uid: user.ref});
    if (ref1) {
      const ref1Bonus = betAmount * 0.01;
      ref1.refEarn += ref1Bonus;
      ref1.balance += ref1Bonus;
      await ref1.save();
    }
  }
  
  res.json({
    win,
    prize: prize.toFixed(2),
    newBalance: user.balance.toFixed(2),
    serverSeed,
    hash
  });
});

// Данные пользователя
app.get('/user/:uid', async (req, res) => {
  const u = await User.findOneAndUpdate({uid: +req.params.uid}, {}, {upsert: true, new: true});
  res.json({
    balance: u.balance,
    refCode: u.uid,
    refCount: await User.countDocuments({ref: u.uid}),
    refEarn: u.refEarn,
    lastBonus: u.lastBonus,
    totalDeposited: u.totalDeposited
  });
});

// Бонус
app.post('/bonus', async (req, res) => {
  const {uid, now} = req.body;
  await User.updateOne({uid}, {lastBonus: now});
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[SERVER] Running on port ${PORT}`));


