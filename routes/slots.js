const express = require('express');
const router = express.Router();
const axios = require('axios');
const { SlotRound, User } = require('../models');

const SYMBOLS = ['🍒', '🍋', '🔔', 'BAR', '💰'];
const WEIGHTS = [40, 30, 15, 10, 5];
const PAYTABLE = {'💰-💰-💰': 50, 'BAR-BAR-BAR': 15, '🔔-🔔-🔔': 8, '🍋-🍋-🍋': 4, '🍒-🍒-🍒': 2};

function getStop() {
  const r = Math.random() * 100;
  let acc = 0;
  for (let i = 0; i < WEIGHTS.length; i++) {
    acc += WEIGHTS[i];
    if (r < acc) return i;
  }
  return 0;
}

router.post('/slots/spin', async (req, res) => {
  const {uid, bet} = req.body;
  const user = await User.findOne({uid});
  if (!user || user.balance < bet) return res.status(400).json({error: 'Insufficient balance'});
  
  // Создаём invoice для проверки оплаты (но списываем с баланса сразу)
  const {data} = await axios.post('https://pay.crypt.bot/api/createInvoice', {
    asset: 'USDT', amount: String(bet), description: `Slots ${bet} USDT`
  }, {headers: {'Crypto-Pay-API-Token': process.env.CRYPTO_TOKEN}});
  
  const round = await SlotRound.create({uid, bet, invoiceId: data.result.invoice_id});
  res.json({invoiceUrl: data.result.pay_url, roundId: round._id});
});

router.get('/slots/stop', async (req, res) => {
  const {roundId, reel} = req.query;
  const r = await SlotRound.findById(roundId);
  if (!r.reels[reel]) { r.reels[reel] = Array.from({length: 3}, () => getStop()); await r.save(); }
  res.json({stopRow: r.reels[reel]});
});

router.get('/slots/win', async (req, res) => {
  const r = await SlotRound.findById(req.query.roundId);
  if (!r.paid) return res.json({win: false});
  
  const grid = [];
  for (let reel = 0; reel < 3; reel++) for (let row = 0; row < 3; row++) grid.push(SYMBOLS[r.reels[reel][row]]);
  
  let total = 0;
  const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 4, 8], [2, 4, 6]];
  lines.forEach(idx => {
    const [a, b, c] = idx.map(i => grid[i]);
    const key = `${a}-${b}-${c}`;
    if (PAYTABLE[key]) total += r.bet * PAYTABLE[key];
  });
  
  if (total > 0) {
    await User.updateOne({uid: r.uid}, {$inc: {balance: total}});
    // Мгновенный вывод выигрыша
    await axios.post('https://pay.crypt.bot/api/transfer', {
      user_id: r.uid, asset: 'USDT', amount: String(total.toFixed(2)), spend_id: 'slot' + r._id
    }, {headers: {'Crypto-Pay-API-Token': process.env.CRYPTO_TOKEN}});
  }
  
  res.json({win: total > 0, multi: total / r.bet});
});
module.exports = router;
