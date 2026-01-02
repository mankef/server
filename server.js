require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
mongoose.connect(process.env.MONGO_URI);
const { User, Invoice } = require('./models');
const slotsRouter = require('./routes/slots');
const fair = require('./utils/fair');
const axios = require('axios');

const CRYPTO_TOKEN = process.env.CRYPTO_TOKEN;
const SERVER_URL = process.env.SERVER_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;

app.use('/', slotsRouter);

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

// Пополнение
app.post('/deposit', async (req, res) => {
  const {uid, amount, refCode} = req.body;
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
  
  res.json({invoiceUrl: data.result.pay_url});
});

// Вывод
app.post('/withdraw', async (req, res) => {
  const {uid, amount} = req.body;
  const user = await User.findOne({uid});
  
  if (!user || user.balance < amount) {
    return res.status(400).json({error: 'Insufficient balance'});
  }
  
  const spend_id = 'withdraw' + uid + Date.now();
  await axios.post('https://pay.crypt.bot/api/transfer', {
    user_id: uid, asset: 'USDT', amount: String(amount.toFixed(2)), spend_id
  }, {headers: {'Crypto-Pay-API-Token': CRYPTO_TOKEN}});
  
  user.balance -= amount;
  await user.save();
  
  res.json({success: true, newBalance: user.balance.toFixed(2)});
});

// Игра монетка
app.post('/play/coin', async (req, res) => {
  const {uid, betAmount, side, clientSeed} = req.body;
  const user = await User.findOne({uid});
  
  if (!user || user.balance < betAmount) {
    return res.status(400).json({error: 'Insufficient balance'});
  }
  
  const {serverSeed, hash} = fair.generateRound();
  const {win} = fair.calculateWin(serverSeed, clientSeed);
  
  user.balance -= betAmount;
  const prize = win ? betAmount * 1.9 : 0;
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

// Webhook для пополнений (ГЛАВНЫЙ ЭНДПОИНТ)
app.post('/webhook', async (req, res) => {
  console.log('[SERVER] Webhook received:', req.body.update?.type);
  
  if (req.body.update?.type !== 'invoice_paid') return res.sendStatus(200);
  
  const {invoice_id} = req.body.update.payload;
  console.log('[SERVER] Processing invoice:', invoice_id);
  
  const inv = await Invoice.findOne({iid: invoice_id});
  if (!inv) {
    console.log('[SERVER] Invoice not found in DB:', invoice_id);
    return res.sendStatus(200);
  }
  
  if (inv.type === 'deposit' && inv.status === 'pending') {
    console.log('[SERVER] Processing deposit for user:', inv.uid, 'amount:', inv.amount);
    
    const user = await User.findOneAndUpdate(
      {uid: inv.uid},
      {$inc: {balance: inv.amount, totalDeposited: inv.amount}},
      {upsert: true, new: true}
    );
    
    // Реферальные
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
    console.log('[SERVER] Deposit processed successfully');
  }
  
  res.sendStatus(200);
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
  await User.updateOne({uid}, {lastBonus: now, $inc: {balance: 0.2}});
  res.sendStatus(200);
});

// Автоматическая настройка вебхука
app.get('/setup-webhook', async (req, res) => {
  if (!CRYPTO_TOKEN) return res.status(500).json({error: 'No token'});
  
  try {
    await axios.post('https://pay.crypt.bot/api/setWebhook', {
      url: `${SERVER_URL}/webhook`
    }, {headers: {'Crypto-Pay-API-Token': CRYPTO_TOKEN}});
    
    res.json({success: true, webhook: `${SERVER_URL}/webhook`});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[SERVER] Running on port ${PORT}`));
