const express = require('express');
const router = express.Router();
const fair = require('../utils/fair');
const { Round } = require('../models');

router.post('/fair/coin', async (req, res) => {
  const {uid, bet, side, clientSeed} = req.body;
  const {serverSeed, hash} = fair.generateRound();
  const r = await Round.create({uid, bet, side, clientSeed, serverSeed, hash});
  res.json({hash, roundId: r._id});
});
module.exports = router;