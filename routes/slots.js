const express = require('express');
const router = express.Router();
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
  
  if (!user || user.balance < bet) {
    return res.status(400).json({error: 'Insufficient balance'});
  }
  
  user.balance -= bet;
  await user.save();
  
  const round = await SlotRound.create({uid, bet, reels: []});
  res.json({success: true, roundId: round._id, newBalance: user.balance});
});

router.get('/slots/stop', async (req, res) => {
  const {roundId, reel} = req.query;
  const r = await SlotRound.findById(roundId);
  if (!r) return res.status(404).json({error: 'Round not found'});
  
  if (!r.reels[reel]) {
    r.reels[reel] = Array.from({length: 3}, () => getStop());
    await r.save();
  }
  res.json({stopRow: r.reels[reel]});
});

router.get('/slots/win', async (req, res) => {
  const r = await SlotRound.findById(req.query.roundId);
  if (!r || r.finished) return res.json({win: false});
  
  const grid = [];
  for (let reel = 0; reel < 3; reel++) {
    for (let row = 0; row < 3; row++) {
      grid.push(SYMBOLS[r.reels[reel][row]]);
    }
  }
  
  let total = 0;
  const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 4, 8], [2, 4, 6]];
  lines.forEach(idx => {
    const [a, b, c] = idx.map(i => grid[i]);
    const key = `${a}-${b}-${c}`;
    if (PAYTABLE[key]) total += r.bet * PAYTABLE[key];
  });
  
  r.win = total;
  r.finished = true;
  await r.save();
  
  const user = await User.findOne({uid: r.uid});
  if (total > 0) {
    user.balance += total;
    await user.save();
    
    if (user.ref) {
      const ref1 = await User.findOne({uid: user.ref});
      if (ref1) {
        const ref1Bonus = total * 0.01;
        ref1.refEarn += ref1Bonus;
        ref1.balance += ref1Bonus;
        await ref1.save();
      }
    }
  }
  
  res.json({win: total > 0, multi: total / r.bet, newBalance: user.balance});
});

module.exports = router;
