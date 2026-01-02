const express = require('express');
const router = express.Router();
const { Settings, User } = require('../models');

// Установить house edge (только админ)
router.post('/set-edge', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.BOT_TOKEN) {
    return res.status(403).json({error: 'Access denied'});
  }
  
  const {edge} = req.body;
  if (typeof edge !== 'number' || edge < 0 || edge > 0.3) {
    return res.status(400).json({error: 'Edge must be 0-0.3 (30%)'});
  }
  
  await Settings.updateOne({}, {houseEdge: edge}, {upsert: true});
  res.json({success: true, houseEdge: edge});
});

// Получить статистику
router.get('/stats', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.BOT_TOKEN) {
    return res.status(403).json({error: 'Access denied'});
  }
  
  const totalUsers = await User.countDocuments();
  const totalDeposited = await User.aggregate([{$group: {_id: null, total: {$sum: '$totalDeposited'}}}]);
  const topReferrers = await User.find().sort({refEarn: -1}).limit(5);
  
  res.json({
    totalUsers,
    totalDeposited: totalDeposited[0]?.total || 0,
    topReferrers: topReferrers.map(u => ({uid: u.uid, refEarn: u.refEarn}))
  });
});

// Поиск пользователя
router.get('/user/:uid', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.BOT_TOKEN) {
    return res.status(403).json({error: 'Access denied'});
  }
  
  const user = await User.findOne({uid: req.params.uid});
  if (!user) return res.status(404).json({error: 'User not found'});
  
  res.json({
    uid: user.uid,
    balance: user.balance,
    refEarn: user.refEarn,
    ref: user.ref,
    totalDeposited: user.totalDeposited
  });
});

module.exports = router;
